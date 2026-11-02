import { randomUUID } from "node:crypto";
import { FastifyInstance } from "fastify";
import { env } from "../../config/env";
import { uploadsRepo, UploadRow } from "../../db/repositories/uploads.repo";
import { videosRepo } from "../../db/repositories/videos.repo";
import { usersRepo } from "../../db/repositories/users.repo";
import { devicesRepo } from "../../db/repositories/devices.repo";
import { ApiError, CODE } from "../../utils/codes";
import { buildVideoObjectKey } from "../../utils/vn-path";
import { resolveSessionFolderName } from "../recording-sessions/recording-sessions.service";

export interface InitUploadMetadata {
  local_video_uid: string;
  device_id: string;
  room_id?: string;
  camera_name?: string;
  session_id?: string;
  recorded_at?: string;
  duration_ms?: number;
  resolution?: string;
  fps?: number;
}

export interface InitUploadInput {
  file_name: string;
  file_size: number;
  mime_type: string;
  checksum_sha256?: string;
  metadata: InitUploadMetadata;
}

function findOwnedUpload(ownerId: string, uploadId: string): UploadRow {
  const upload = uploadsRepo.findById(uploadId);
  if (!upload || upload.owner_id !== ownerId) {
    throw new ApiError(CODE.NOT_EXISTED, "Upload session not found");
  }
  return upload;
}

function assertNotExpired(upload: UploadRow): void {
  if (upload.status !== "pending") {
    throw new ApiError(CODE.NOT_EXISTED, "Upload session is not active");
  }
  if (new Date(upload.expires_at).getTime() < Date.now()) {
    uploadsRepo.setStatus(upload.id, "expired");
    throw new ApiError(CODE.NOT_EXISTED, "Upload session expired");
  }
}

export async function initUpload(app: FastifyInstance, ownerId: string, input: InitUploadInput) {
  if (input.mime_type !== "video/mp4") {
    throw new ApiError(CODE.PARAM_VALUE_INVALID, "mime_type must be video/mp4");
  }
  if (!Number.isInteger(input.file_size) || input.file_size <= 0) {
    throw new ApiError(CODE.PARAM_VALUE_INVALID, "file_size must be a positive integer");
  }
  if (input.file_size > env.upload.maxFileSizeBytes) {
    throw new ApiError(CODE.FILE_TOO_BIG);
  }

  const user = usersRepo.findById(ownerId);
  if (user && user.storage_used + input.file_size > user.storage_quota) {
    throw new ApiError(CODE.MAX_ITEMS_EXCEEDED, "Storage quota exceeded");
  }

  // No checksum → stored as "" so dedupe falls back to local_video_uid alone
  // (matches the videos UNIQUE(owner_id, local_video_uid, checksum_sha256)).
  const checksum = input.checksum_sha256 ?? "";
  const { metadata } = input;
  const existing = videosRepo.findByLocalUidAndChecksum(ownerId, metadata.local_video_uid, checksum);
  if (existing) {
    return {
      upload_id: null,
      upload_url: null,
      expires_at: null,
      already_uploaded: 1,
      video_id: existing.id,
    };
  }

  // Cấu trúc MinIO: room_id / session_id_time_vn / device_id_brand_time.mp4
  // Folder lấy time từ recording_sessions.started_at (resolveSessionFolderName) để khớp
  // folder session.json; tên file mới dùng recorded_at.
  // Client không gửi room_id (quay ngoài phòng) → room segment = "_standalone".
  const device = devicesRepo.findById(metadata.device_id);
  const recordedAt = metadata.recorded_at ?? new Date().toISOString();
  const objectKey = buildVideoObjectKey(
    metadata.room_id,
    resolveSessionFolderName(metadata.session_id ?? "standalone", recordedAt),
    metadata.device_id,
    device?.model,
    recordedAt,
    device?.device_name
  );

  const uploadId = randomUUID();
  const expiresAt = new Date(Date.now() + env.upload.sessionTtlMs).toISOString();
  const uploadUrl = await app.minioPublic.presignedPutObject(
    env.minio.bucket,
    objectKey,
    Math.floor(env.upload.sessionTtlMs / 1000)
  );

  uploadsRepo.insert({
    id: uploadId,
    owner_id: ownerId,
    device_id: metadata.device_id,
    file_name: input.file_name,
    file_size: input.file_size,
    mime_type: input.mime_type,
    checksum_sha256: checksum,
    object_key: objectKey,
    metadata_json: JSON.stringify(metadata),
    status: "pending",
    expires_at: expiresAt,
  });

  return {
    upload_id: uploadId,
    upload_url: uploadUrl,
    expires_at: expiresAt,
    already_uploaded: 0,
    video_id: null,
  };
}

export async function completeUpload(app: FastifyInstance, ownerId: string, uploadId: string) {
  const upload = findOwnedUpload(ownerId, uploadId);
  assertNotExpired(upload);

  let size: number;
  try {
    size = (await app.minio.statObject(env.minio.bucket, upload.object_key)).size;
  } catch (err) {
    if ((err as { code?: string }).code === "NotFound") {
      throw new ApiError(CODE.COULD_NOT_COMPLETE, "File has not been uploaded to upload_url yet");
    }
    throw err;
  }
  if (size !== upload.file_size) {
    uploadsRepo.setStatus(uploadId, "failed");
    throw new ApiError(
      CODE.UPLOAD_FAILED,
      `Uploaded size ${size} does not match file_size ${upload.file_size}`
    );
  }

  const metadata: InitUploadMetadata = JSON.parse(upload.metadata_json);
  const videoId = randomUUID();
  videosRepo.insert({
    id: videoId,
    owner_id: ownerId,
    device_id: metadata.device_id,
    session_id: metadata.session_id ?? null,
    local_video_uid: metadata.local_video_uid,
    camera_name: metadata.camera_name ?? null,
    name: upload.file_name,
    description: null,
    object_key: upload.object_key,
    thumbnail_key: null,
    duration_ms: metadata.duration_ms ?? null,
    size_bytes: upload.file_size,
    resolution: metadata.resolution ?? null,
    fps: metadata.fps ?? null,
    codec: "h264/aac",
    checksum_sha256: upload.checksum_sha256,
    recorded_at: metadata.recorded_at ?? null,
  });
  usersRepo.incrementStorageUsed(ownerId, upload.file_size);
  uploadsRepo.setStatus(uploadId, "completed");

  const url = await app.minioPublic.presignedGetObject(env.minio.bucket, upload.object_key, 3600);
  const video = videosRepo.findById(videoId)!;

  return {
    video_id: video.id,
    local_video_uid: video.local_video_uid,
    url,
    thumbnail_url: null,
    duration_ms: video.duration_ms,
    size: video.size_bytes,
    created_at: video.uploaded_at,
  };
}

export function abortUpload(ownerId: string, uploadId: string): void {
  findOwnedUpload(ownerId, uploadId);
  uploadsRepo.setStatus(uploadId, "aborted");
}
