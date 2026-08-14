import fastifyJwt from "@fastify/jwt";
import fp from "fastify-plugin";
import { FastifyInstance } from "fastify";
import { env } from "../config/env";

export default fp(async function jwtPlugin(app: FastifyInstance) {
  await app.register(fastifyJwt, {
    secret: env.jwtSecret,
  });
});
