import { AccountRole } from "../db/repositories/users.repo";

export interface AccessTokenPayload {
  sub: string; // user id
  acc: AccountRole; // account role claim, per spec section 1.3
  device_id: string;
  type: "access";
}

export interface RefreshTokenPayload {
  sub: string;
  device_id: string;
  type: "refresh";
}

declare module "fastify" {
  interface FastifyRequest {
    auth?: {
      userId: string;
      accountRole: AccountRole;
      deviceId: string;
    };
  }
}
