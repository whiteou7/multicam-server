import fp from "fastify-plugin";
import { FastifyInstance } from "fastify";
import { Client } from "minio";
import { env } from "../config/env";

declare module "fastify" {
  interface FastifyInstance {
    minio: Client;
    /** Presign-only client signed for the public S3 host. Never use it for server-side calls. */
    minioPublic: Client;
  }
}

export function createPublicMinioClient(): Client {
  const pub = env.minio.publicEndPoint;
  return new Client({
    endPoint: pub ?? env.minio.endPoint,
    port: pub ? env.minio.publicPort : env.minio.port,
    useSSL: pub ? env.minio.publicUseSSL : env.minio.useSSL,
    accessKey: env.minio.accessKey,
    secretKey: env.minio.secretKey,
    // Explicit region: presigning is pure computation, no region lookup over the network.
    // shortcut: assumes MinIO's default region, add MINIO_REGION if a region is ever configured.
    region: "us-east-1",
  });
}

export default fp(async function minioPlugin(app: FastifyInstance) {
  const client = new Client({
    endPoint: env.minio.endPoint,
    port: env.minio.port,
    useSSL: env.minio.useSSL,
    accessKey: env.minio.accessKey,
    secretKey: env.minio.secretKey,
  });

  const exists = await client.bucketExists(env.minio.bucket).catch(() => false);
  if (!exists) {
    await client.makeBucket(env.minio.bucket);
    app.log.info(`Created MinIO bucket "${env.minio.bucket}"`);
  }

  app.decorate("minio", client);
  app.decorate("minioPublic", createPublicMinioClient());
});
