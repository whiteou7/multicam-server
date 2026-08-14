import { randomUUID } from "node:crypto";
import path from "node:path";
import { FastifyInstance } from "fastify";
import { env } from "../../config/env";
import { uploadsRepo, UploadRow } from "../../db/repositories/uploads.repo";
import { videosRepo } from "../../db/repositories/videos.repo";
import { usersRepo } from "../../db/repositories/users.repo";
import { ApiError, CODE } from "../../utils/codes";
import { chunkPath, combineChunks, ensureDir, removeDir, sha256OfBuffer, sha256OfFile } from "./upload-fs";
import fs from "node:fs/promises";

export interface InitUploadMetadata {
  local_video_uid: string;
  device_id: string;
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
  checksum_sha256: string;
  metadata: InitUploadMetadata;
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

export function initUpload(ownerId: string, input: InitUploadInput) {
  if (input.mime_type !== "video/mp4") {
    throw new ApiError(CODE.PARAM_VALUE_INVALID, "mime_type must be video/mp4");
  }
  if (input.file_size > env.upload.maxFileSizeBytes) {
    throw new ApiError(CODE.FILE_TOO_BIG);
  }

  const user = usersRepo.findById(ownerId);
  if (user && user.storage_used + input.file_size > user.storage_quota) {
    throw new ApiError(CODE.MAX_ITEMS_EXCEEDED, "Storage quota exceeded");
  }

  const existing = videosRepo.findByLocalUidAndChecksum(
    ownerId,
    input.metadata.local_video_uid,
    input.checksum_sha256
  );
  if (existing) {
    return {
      upload_id: null,
      chunk_size: env.upload.chunkSizeBytes,
      total_chunks: 0,
      expires_at: null,
      already_uploaded: 1,
      video_id: existing.id,
    };
  }

  const uploadId = randomUUID();
  const chunkSize = env.upload.chunkSizeBytes;
  const totalChunks = Math.max(1, Math.ceil(input.file_size / chunkSize));
  const tmpDir = path.join(env.upload.tmpDir, uploadId);
  const expiresAt = new Date(Date.now() + env.upload.sessionTtlMs).toISOString();

  uploadsRepo.insert({
    id: uploadId,
    owner_id: ownerId,
    device_id: input.metadata.device_id,
    file_name: input.file_name,
    file_size: input.file_size,
    mime_type: input.mime_type,
    checksum_sha256: input.checksum_sha256,
    chunk_size: chunkSize,
    total_chunks: totalChunks,
    metadata_json: JSON.stringify(input.metadata),
    status: "pending",
    tmp_dir: tmpDir,
    expires_at: expiresAt,
  });

  return {
    upload_id: uploadId,
    chunk_size: chunkSize,
    total_chunks: totalChunks,
    expires_at: expiresAt,
    already_uploaded: 0,
    video_id: null,
  };
}

export async function writeChunk(
  ownerId: string,
  uploadId: string,
  chunkIndex: number,
  buffer: Buffer,
  chunkChecksumHeader?: string
) {
  const upload = uploadsRepo.findById(uploadId);
  if (!upload || upload.owner_id !== ownerId) {
    throw new ApiError(CODE.NOT_EXISTED, "Upload session not found");
  }
  assertNotExpired(upload);

  if (chunkIndex < 0 || chunkIndex >= upload.total_chunks) {
    throw new ApiError(CODE.PARAM_VALUE_INVALID, "chunk index out of range");
  }
  if (buffer.length === 0) {
    throw new ApiError(CODE.UPLOAD_FAILED, "Empty chunk body");
  }

  if (chunkChecksumHeader) {
    const actual = sha256OfBuffer(buffer);
    if (actual.toLowerCase() !== chunkChecksumHeader.toLowerCase()) {
      throw new ApiError(CODE.UPLOAD_FAILED, "chunk_checksum mismatch");
    }
  }

  await ensureDir(upload.tmp_dir);
  await fs.writeFile(chunkPath(upload.tmp_dir, chunkIndex), buffer);
  uploadsRepo.recordChunk(uploadId, chunkIndex, buffer.length, chunkChecksumHeader);

  const received = new Set(uploadsRepo.receivedChunkIndexes(uploadId));
  let nextExpected: number | null = null;
  for (let i = 0; i < upload.total_chunks; i++) {
    if (!received.has(i)) {
      nextExpected = i;
      break;
    }
  }

  return {
    chunk_index: chunkIndex,
    received: buffer.length,
    next_expected_index: nextExpected,
  };
}

export function getUploadStatus(ownerId: string, uploadId: string) {
  const upload = uploadsRepo.findById(uploadId);
  if (!upload || upload.owner_id !== ownerId) {
    throw new ApiError(CODE.NOT_EXISTED, "Upload session not found");
  }
  const received = uploadsRepo.receivedChunkIndexes(uploadId);
  const receivedSet = new Set(received);
  const missing: number[] = [];
  for (let i = 0; i < upload.total_chunks; i++) {
    if (!receivedSet.has(i)) missing.push(i);
  }
  return {
    upload_id: upload.id,
    status: upload.status,
    received_chunks: received,
    missing_chunks: missing,
    expires_at: upload.expires_at,
  };
}

export async function completeUpload(app: FastifyInstance, ownerId: string, uploadId: string) {
  const upload = uploadsRepo.findById(uploadId);
  if (!upload || upload.owner_id !== ownerId) {
    throw new ApiError(CODE.NOT_EXISTED, "Upload session not found");
  }
  assertNotExpired(upload);

  const receivedSet = new Set(uploadsRepo.receivedChunkIndexes(uploadId));
  for (let i = 0; i < upload.total_chunks; i++) {
    if (!receivedSet.has(i)) {
      throw new ApiError(CODE.COULD_NOT_COMPLETE, `Missing chunk ${i}`);
    }
  }

  const metadata: InitUploadMetadata = JSON.parse(upload.metadata_json);
  const combinedPath = path.join(upload.tmp_dir, "combined.mp4");
  await combineChunks(upload.tmp_dir, upload.total_chunks, combinedPath);

  const actualChecksum = await sha256OfFile(combinedPath);
  if (actualChecksum.toLowerCase() !== upload.checksum_sha256.toLowerCase()) {
    await removeDir(upload.tmp_dir);
    uploadsRepo.setStatus(uploadId, "aborted");
    throw new ApiError(CODE.UPLOAD_FAILED, "checksum_sha256 mismatch after assembly");
  }

  const videoId = randomUUID();
  const sessionId = metadata.session_id ?? "standalone";
  const objectKey = `videos/${ownerId}/${metadata.device_id}/${sessionId}/${videoId}.mp4`;

  await app.minio.fPutObject(env.minio.bucket, objectKey, combinedPath, {
    "Content-Type": "video/mp4",
  });

  videosRepo.insert({
    id: videoId,
    owner_id: ownerId,
    device_id: metadata.device_id,
    session_id: metadata.session_id ?? null,
    local_video_uid: metadata.local_video_uid,
    camera_name: metadata.camera_name ?? null,
    name: upload.file_name,
    description: null,
    object_key: objectKey,
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
  await removeDir(upload.tmp_dir);

  const url = await app.minio.presignedGetObject(env.minio.bucket, objectKey, 3600);
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

export async function abortUpload(ownerId: string, uploadId: string): Promise<void> {
  const upload = uploadsRepo.findById(uploadId);
  if (!upload || upload.owner_id !== ownerId) {
    throw new ApiError(CODE.NOT_EXISTED, "Upload session not found");
  }
  await removeDir(upload.tmp_dir);
  uploadsRepo.deleteChunks(uploadId);
  uploadsRepo.setStatus(uploadId, "aborted");
}
