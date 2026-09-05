import { FastifyReply, FastifyRequest } from "fastify";
import { ApiError, CODE } from "../utils/codes";
import { AccessTokenPayload } from "../types/auth";
import { AccountRole } from "../db/repositories/users.repo";

export async function authenticate(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
  try {
    let payload: AccessTokenPayload | null = null;
    try {
      payload = await request.jwtVerify<AccessTokenPayload>();
    } catch {
      const q = request.query as Record<string, unknown> | undefined;
      const t = typeof q?.token === 'string' ? (q.token as string) : undefined;
      if (t) {
        payload = (request.server as unknown as { jwt: { verify: (token: string) => AccessTokenPayload } }).jwt.verify(t);
      } else {
        throw new ApiError(CODE.TOKEN_INVALID);
      }
    }
    if (!payload || payload.type !== "access") throw new ApiError(CODE.TOKEN_INVALID);
    request.auth = { userId: payload.sub, accountRole: payload.acc, deviceId: payload.device_id };
  } catch (err) {
    if (err instanceof ApiError) throw err;
    throw new ApiError(CODE.TOKEN_INVALID);
  }
}

export function requireRole(...roles: AccountRole[]) {
  return async function (request: FastifyRequest, _reply: FastifyReply): Promise<void> {
    if (!request.auth || !roles.includes(request.auth.accountRole)) {
      throw new ApiError(CODE.NOT_ACCESS);
    }
  };
}
