import { FastifyInstance } from "fastify";
import { env } from "../../config/env";
import { videosRepo } from "../../db/repositories/videos.repo";
import { authenticate, requireRole } from "../../middleware/authenticate";
import { ApiError, CODE } from "../../utils/codes";
import { ok } from "../../utils/response";
import { requireField } from "../../utils/validate";

interface CheckUploadedItem {
  local_video_uid: string;
  checksum_sha256: string;
  file_size: number;
}

interface ListVideosQuery {
  index?: string;
  count?: string;
  session_id?: string;
  device_id?: string;
  sort?: "created_at_desc" | "created_at_asc";
}

export default async function videosRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: { items: CheckUploadedItem[] } }>(
    "/videos/check-uploaded",
    { preHandler: authenticate },
    async (request) => {
      const items = requireField(request.body?.items, "items");
      if (!Array.isArray(items)) {
        throw new ApiError(CODE.PARAM_TYPE_INVALID, "items must be an array");
      }
      if (items.length > 100) {
        throw new ApiError(CODE.MAX_ITEMS_EXCEEDED);
      }
      const results = items.map((item) => {
        const video = videosRepo.findByLocalUidAndChecksum(
          request.auth!.userId,
          item.local_video_uid,
          item.checksum_sha256
        );
        return {
          local_video_uid: item.local_video_uid,
          uploaded: video ? 1 : 0,
          video_id: video?.id ?? null,
          uploaded_at: video?.uploaded_at ?? null,
        };
      });
      return ok({ items: results });
    }
  );

  app.get<{ Querystring: ListVideosQuery }>(
    "/videos",
    { preHandler: authenticate },
    async (request) => {
      const index = Number(request.query.index ?? 0);
      const count = Math.min(Number(request.query.count ?? 20), 100);
      // Remote accounts see only their own clips. Controllers see every uploaded
      // clip (room-scoped filtering lands with the room/session milestone).
      const ownerFilter = request.auth!.accountRole === "controller" ? null : request.auth!.userId;

      const videos = ownerFilter
        ? videosRepo.listForUser(ownerFilter, {
            index,
            count,
            sessionId: request.query.session_id,
            deviceId: request.query.device_id,
            sortAsc: request.query.sort === "created_at_asc",
          })
        : videosRepo.listAll({
            index,
            count,
            sessionId: request.query.session_id,
            deviceId: request.query.device_id,
            sortAsc: request.query.sort === "created_at_asc",
          });

      if (videos.length === 0) {
        return ok({ videos: [], total: 0 }, "No data or end of list data");
      }

      return ok({
        videos: videos.map((v) => ({
          id: v.id,
          name: v.name,
          thumbnail_url: null,
          duration_ms: v.duration_ms,
          size: v.size_bytes,
          created_at: v.uploaded_at,
          camera_name: v.camera_name,
          device_id: v.device_id,
          session_id: v.session_id,
          local_video_uid: v.local_video_uid,
          downloaded_by_controller: v.downloaded_by_controller,
        })),
        total: videos.length,
      });
    }
  );

  app.get<{ Params: { video_id: string } }>(
    "/videos/:video_id",
    { preHandler: authenticate },
    async (request) => {
      const video = videosRepo.findById(request.params.video_id);
      if (!video) throw new ApiError(CODE.NOT_EXISTED);
      if (request.auth!.accountRole !== "controller" && video.owner_id !== request.auth!.userId) {
        throw new ApiError(CODE.NOT_ACCESS);
      }
      const url = await app.minio.presignedGetObject(env.minio.bucket, video.object_key, 3600);
      return ok({
        id: video.id,
        name: video.name,
        url,
        thumbnail_url: null,
        duration_ms: video.duration_ms,
        size: video.size_bytes,
        resolution: video.resolution,
        codec: video.codec,
        created_at: video.uploaded_at,
        owner: video.owner_id,
        camera_name: video.camera_name,
        session_id: video.session_id,
        local_video_uid: video.local_video_uid,
      });
    }
  );

  app.put<{ Params: { video_id: string }; Body: { name?: string; description?: string } }>(
    "/videos/:video_id",
    { preHandler: authenticate },
    async (request) => {
      const video = videosRepo.findById(request.params.video_id);
      if (!video) throw new ApiError(CODE.NOT_EXISTED);
      if (video.owner_id !== request.auth!.userId) throw new ApiError(CODE.NOT_ACCESS);
      const { name, description } = request.body ?? {};
      if (name !== undefined && (name.length === 0 || name.length > 100)) {
        throw new ApiError(CODE.PARAM_VALUE_INVALID, "name must be 1-100 characters");
      }
      if (description !== undefined && description.length > 500) {
        throw new ApiError(CODE.PARAM_VALUE_INVALID, "description must be at most 500 characters");
      }
      videosRepo.updateNameDescription(request.params.video_id, name, description);
      const updated = videosRepo.findById(request.params.video_id)!;
      return ok({
        id: updated.id,
        name: updated.name,
        description: updated.description,
        updated_at: new Date().toISOString(),
      });
    }
  );

  app.delete<{ Params: { video_id: string } }>(
    "/videos/:video_id",
    { preHandler: authenticate },
    async (request) => {
      const video = videosRepo.findById(request.params.video_id);
      if (!video) throw new ApiError(CODE.NOT_EXISTED);
      if (video.owner_id !== request.auth!.userId) throw new ApiError(CODE.NOT_ACCESS);
      videosRepo.softDelete(request.params.video_id);
      return ok({ deleted_at: new Date().toISOString() });
    }
  );

  app.post<{ Body: { video_ids: string[] } }>(
    "/videos/bulk-delete",
    { preHandler: authenticate },
    async (request) => {
      const videoIds = requireField(request.body?.video_ids, "video_ids");
      if (!Array.isArray(videoIds)) throw new ApiError(CODE.PARAM_TYPE_INVALID, "video_ids must be an array");
      if (videoIds.length > 50) throw new ApiError(CODE.MAX_ITEMS_EXCEEDED);

      const deleted: string[] = [];
      const failed: { id: string; reason: string }[] = [];
      for (const id of videoIds) {
        const video = videosRepo.findById(id);
        if (!video) {
          failed.push({ id, reason: "not_found" });
          continue;
        }
        if (video.owner_id !== request.auth!.userId) {
          failed.push({ id, reason: "not_access" });
          continue;
        }
        videosRepo.softDelete(id);
        deleted.push(id);
      }
      return ok({ deleted, failed });
    }
  );

  app.get<{ Params: { video_id: string } }>(
    "/videos/:video_id/download",
    { preHandler: [authenticate, requireRole("controller")] },
    async (request) => {
      const video = videosRepo.findById(request.params.video_id);
      if (!video) throw new ApiError(CODE.NOT_EXISTED);

      const download_url = await app.minio.presignedGetObject(
        env.minio.bucket,
        video.object_key,
        env.upload.downloadUrlTtlSeconds
      );
      videosRepo.markDownloadedByController(video.id);

      return ok({
        download_url,
        expires_at: new Date(Date.now() + env.upload.downloadUrlTtlSeconds * 1000).toISOString(),
        size: video.size_bytes,
        checksum_sha256: video.checksum_sha256,
      });
    }
  );
}
