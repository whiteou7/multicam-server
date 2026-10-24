import { test } from "node:test";
import assert from "node:assert/strict";
import type { FastifyInstance } from "fastify";

// Must be set before the app modules (and dotenv) load.
process.env.DATABASE_PATH = ":memory:";
process.env.MINIO_ENDPOINT = "minio";
process.env.MINIO_PUBLIC_ENDPOINT = "s3.example.com";
process.env.MINIO_PUBLIC_USE_SSL = "true";

async function setup(objectSize: number) {
  const { seedDefaultAccounts } = await import("../src/db/seed");
  const { usersRepo } = await import("../src/db/repositories/users.repo");
  const { uploadsRepo } = await import("../src/db/repositories/uploads.repo");
  const { createPublicMinioClient } = await import("../src/plugins/minio");
  const service = await import("../src/modules/videos/uploads.service");
  seedDefaultAccounts();
  const app = {
    minioPublic: createPublicMinioClient(),
    minio: { statObject: async () => ({ size: objectSize }) },
  } as unknown as FastifyInstance;
  const userId = usersRepo.findByEmailOrPhone("remote1@multicam.local")!.id;
  const init = (localUid: string) =>
    service.initUpload(app, userId, {
      file_name: "clip.mp4",
      file_size: 1000,
      mime_type: "video/mp4",
      metadata: { local_video_uid: localUid, device_id: "dev-1" },
    });
  return { app, userId, init, service, uploadsRepo };
}

test("init returns a presigned PUT URL on the public S3 host", async () => {
  const { init } = await setup(1000);
  const res = await init("uid-presign");
  const url = new URL(res.upload_url!);
  assert.equal(url.protocol, "https:");
  assert.equal(url.host, "s3.example.com");
  assert.match(url.pathname, /^\/multicam-videos\/_standalone\/.+\.mp4$/);
  assert.ok(url.searchParams.get("X-Amz-Signature"));
});

test("complete rejects an object whose size differs from file_size", async () => {
  const { app, userId, init, service, uploadsRepo } = await setup(999);
  const res = await init("uid-mismatch");
  await assert.rejects(service.completeUpload(app, userId, res.upload_id!), { code: 1007 });
  assert.equal(uploadsRepo.findById(res.upload_id!)!.status, "failed");
});
