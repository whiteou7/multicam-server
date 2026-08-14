import { FastifyReply, FastifyRequest } from "fastify";
import { ApiError, CODE } from "../utils/codes";
import { AccessTokenPayload } from "../types/auth";
import { AccountRole } from "../db/repositories/users.repo";

export async function authenticate(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
  try {
    const payload = await request.jwtVerify<AccessTokenPayload>();
    if (payload.type !== "access") {
      throw new ApiError(CODE.TOKEN_INVALID);
    }
    request.auth = {
      userId: payload.sub,
      accountRole: payload.acc,
      deviceId: payload.device_id,
    };
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
