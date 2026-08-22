import cors from "@fastify/cors";
import Fastify, { FastifyInstance } from "fastify";
import { ApiError, CODE, MESSAGE } from "./utils/codes";
import jwtPlugin from "./plugins/jwt";
import minioPlugin from "./plugins/minio";
import authRoutes from "./modules/auth/auth.routes";
import devicesRoutes from "./modules/devices/devices.routes";
import videosRoutes from "./modules/videos/videos.routes";
import uploadsRoutes from "./modules/videos/uploads.routes";
import roomsRoutes from "./modules/rooms/rooms.routes";
import recordingSessionsRoutes from "./modules/recording-sessions/recording-sessions.routes";
import appRoutes from "./modules/app/app.routes";
import { env } from "./config/env";

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: true,
    // Chunk bodies are raw binary up to chunk_size; leave headroom above it.
    bodyLimit: env.upload.chunkSizeBytes + 1024 * 1024,
  });

  await app.register(cors, { origin: true });
  await app.register(jwtPlugin);
  await app.register(minioPlugin);

  // Chunk upload endpoints send raw binary with Content-Type: application/octet-stream.
  app.addContentTypeParser(
    "application/octet-stream",
    { parseAs: "buffer" },
    (_req, body, done) => done(null, body)
  );

  // Registered before route plugins: Fastify's encapsulation captures the
  // error/not-found handler active in a context at the time its routes are
  // defined, so this must run first to apply to every route below.
  app.setNotFoundHandler((_request, reply) => {
    reply.status(404).send({ code: CODE.NOT_EXISTED, message: MESSAGE[CODE.NOT_EXISTED], data: {} });
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ApiError) {
      reply.status(error.httpStatus).send({ code: error.code, message: error.message, data: {} });
      return;
    }
    // fastify validation / unexpected errors -> generic "can't connect" per spec section 1.3
    request.log.error(error);
    reply
      .status(500)
      .send({ code: CODE.EXCEPTION_ERROR, message: MESSAGE[CODE.EXCEPTION_ERROR], data: {} });
  });

  app.get("/health", async () => ({ code: CODE.OK, message: "OK", data: { status: "up" } }));

  // Matches the base URL declared in specs/v3_...: https://<domain>/it4788/api/v1
  const API_PREFIX = "/it4788/api/v1";
  await app.register(authRoutes, { prefix: API_PREFIX });
  await app.register(devicesRoutes, { prefix: API_PREFIX });
  await app.register(videosRoutes, { prefix: API_PREFIX });
  await app.register(uploadsRoutes, { prefix: API_PREFIX });
  await app.register(roomsRoutes, { prefix: API_PREFIX });
  await app.register(recordingSessionsRoutes, { prefix: API_PREFIX });
  await app.register(appRoutes, { prefix: API_PREFIX });

  return app;
}
