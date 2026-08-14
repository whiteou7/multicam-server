import { FastifyInstance } from "fastify";
import { env } from "../../config/env";
import { AccountRole } from "../../db/repositories/users.repo";
import { AccessTokenPayload, RefreshTokenPayload } from "../../types/auth";

export function issueTokens(
  app: FastifyInstance,
  userId: string,
  deviceId: string,
  accountRole: AccountRole
) {
  const accessPayload: AccessTokenPayload = {
    sub: userId,
    acc: accountRole,
    device_id: deviceId,
    type: "access",
  };
  const refreshPayload: RefreshTokenPayload = {
    sub: userId,
    device_id: deviceId,
    type: "refresh",
  };

  const access_token = app.jwt.sign(accessPayload, { expiresIn: env.accessTokenTtlSeconds });
  const refresh_token = app.jwt.sign(refreshPayload, { expiresIn: env.refreshTokenTtlSeconds });

  return { access_token, refresh_token, expires_in: env.accessTokenTtlSeconds };
}
