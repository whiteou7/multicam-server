import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import Fastify, { FastifyInstance } from "fastify";
import { ApiError, CODE, MESSAGE } from "./utils/codes";
import jwtPlugin from "./plugins/jwt";
import minioPlugin from "./plugins/minio";
import mediasoupPlugin from "./plugins/mediasoup";
import authRoutes from "./modules/auth/auth.routes";
import devicesRoutes from "./modules/devices/devices.routes";
import videosRoutes from "./modules/videos/videos.routes";
import uploadsRoutes from "./modules/videos/uploads.routes";
import roomsRoutes from "./modules/rooms/rooms.routes";
import mediaWsRoutes from "./modules/media/media.ws.routes";
import recordingSessionsRoutes from "./modules/recording-sessions/recording-sessions.routes";
import appRoutes from "./modules/app/app.routes";
import path from "path";
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
  await app.register(websocket);
  await app.register(mediasoupPlugin);

  // Chunk upload endpoints send raw binary with Content-Type: application/octet-stream.
  app.addContentTypeParser(
    "application/octet-stream",
    { parseAs: "buffer" },
    (_req, body, done) => done(null, body)
  );

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ApiError) {
      reply.status(error.httpStatus).send({ code: error.code, message: error.message, data: {} });
      return;
    }
    request.log.error(error);
    reply
      .status(500)
      .send({ code: CODE.EXCEPTION_ERROR, message: MESSAGE[CODE.EXCEPTION_ERROR], data: {} });
  });

  // dashboard web cho Chrome — http://localhost:PORT/
  app.get("/", async (_req, reply) => {
    const fs = await import("fs");
    const html = fs.readFileSync(path.join(__dirname, "../public/index.html"), "utf8");
    return reply.type("text/html").send(html);
  });
  app.get("/mediasoup-client.bundle.js", async (_req, reply) => {
    const fs = await import("fs");
    const js = fs.readFileSync(path.join(__dirname, "../public/mediasoup-client.bundle.js"), "utf8");
    return reply.type("application/javascript").send(js);
  });

  app.get("/health", async () => ({ code: CODE.OK, message: "OK", data: { status: "up" } }));

  // Matches the base URL declared in specs/v3_...: https://<domain>/it4788/api/v1
  const API_PREFIX = "/it4788/api/v1";
  await app.register(authRoutes, { prefix: API_PREFIX });
  await app.register(devicesRoutes, { prefix: API_PREFIX });
  await app.register(videosRoutes, { prefix: API_PREFIX });
  await app.register(uploadsRoutes, { prefix: API_PREFIX });
  await app.register(roomsRoutes, { prefix: API_PREFIX });
  await app.register(mediaWsRoutes, { prefix: API_PREFIX });
  await app.register(recordingSessionsRoutes, { prefix: API_PREFIX });
  await app.register(appRoutes, { prefix: API_PREFIX });

  // Must be last: catch all unmatched API routes as 9992 (must be after static/health)
  app.setNotFoundHandler((_request, reply) => {
    reply.status(404).send({ code: CODE.NOT_EXISTED, message: MESSAGE[CODE.NOT_EXISTED], data: {} });
  });

  return app;
}
