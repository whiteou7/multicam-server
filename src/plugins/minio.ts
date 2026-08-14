import fp from "fastify-plugin";
import { FastifyInstance } from "fastify";
import { Client } from "minio";
import { env } from "../config/env";

declare module "fastify" {
  interface FastifyInstance {
    minio: Client;
  }
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
});
