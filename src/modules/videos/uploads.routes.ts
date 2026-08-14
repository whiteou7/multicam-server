import { FastifyInstance } from "fastify";
import { authenticate } from "../../middleware/authenticate";
import { ok } from "../../utils/response";
import { assertNumber, assertString, requireField } from "../../utils/validate";
import * as uploadsService from "./uploads.service";
import { InitUploadInput } from "./uploads.service";

export default async function uploadsRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: InitUploadInput }>(
    "/videos/uploads",
    { preHandler: authenticate },
    async (request) => {
      const body = request.body ?? ({} as InitUploadInput);
      const fileName = assertString(requireField(body.file_name, "file_name"), "file_name");
      const fileSize = assertNumber(requireField(body.file_size, "file_size"), "file_size");
      const mimeType = assertString(requireField(body.mime_type, "mime_type"), "mime_type");
      const checksum = assertString(
        requireField(body.checksum_sha256, "checksum_sha256"),
        "checksum_sha256"
      );
      const metadata = requireField(body.metadata, "metadata");
      assertString(requireField(metadata.local_video_uid, "metadata.local_video_uid"), "metadata.local_video_uid");
      assertString(requireField(metadata.device_id, "metadata.device_id"), "metadata.device_id");

      const result = uploadsService.initUpload(request.auth!.userId, {
        file_name: fileName,
        file_size: fileSize,
        mime_type: mimeType,
        checksum_sha256: checksum,
        metadata,
      });
      return ok(result);
    }
  );

  app.put<{ Params: { uploadId: string; index: string } }>(
    "/videos/uploads/:uploadId/chunks/:index",
    { preHandler: authenticate },
    async (request) => {
      const chunkIndex = Number(request.params.index);
      const checksumHeader =
        (request.headers["chunk-checksum"] as string | undefined) ??
        (request.headers["x-chunk-checksum"] as string | undefined);
      const buffer = request.body as Buffer;
      const result = await uploadsService.writeChunk(
        request.auth!.userId,
        request.params.uploadId,
        chunkIndex,
        buffer,
        checksumHeader
      );
      return ok(result);
    }
  );

  app.get<{ Params: { uploadId: string } }>(
    "/videos/uploads/:uploadId",
    { preHandler: authenticate },
    async (request) => {
      return ok(uploadsService.getUploadStatus(request.auth!.userId, request.params.uploadId));
    }
  );

  app.post<{ Params: { uploadId: string } }>(
    "/videos/uploads/:uploadId/complete",
    { preHandler: authenticate },
    async (request) => {
      const result = await uploadsService.completeUpload(app, request.auth!.userId, request.params.uploadId);
      return ok(result);
    }
  );

  app.delete<{ Params: { uploadId: string } }>(
    "/videos/uploads/:uploadId",
    { preHandler: authenticate },
    async (request) => {
      await uploadsService.abortUpload(request.auth!.userId, request.params.uploadId);
      return ok({});
    }
  );
}
