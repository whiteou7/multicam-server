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
      const checksum =
        body.checksum_sha256 == null ? undefined : assertString(body.checksum_sha256, "checksum_sha256");
      const metadata = requireField(body.metadata, "metadata");
      assertString(requireField(metadata.local_video_uid, "metadata.local_video_uid"), "metadata.local_video_uid");
      assertString(requireField(metadata.device_id, "metadata.device_id"), "metadata.device_id");

      const result = await uploadsService.initUpload(app, request.auth!.userId, {
        file_name: fileName,
        file_size: fileSize,
        mime_type: mimeType,
        checksum_sha256: checksum,
        metadata,
      });
      return ok(result);
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
      uploadsService.abortUpload(request.auth!.userId, request.params.uploadId);
      return ok({});
    }
  );
}
