import { randomUUID } from "node:crypto";
import { FastifyInstance } from "fastify";
import { usersRepo } from "../../db/repositories/users.repo";
import { devicesRepo } from "../../db/repositories/devices.repo";
import { verifyCodesRepo } from "../../db/repositories/verify-codes.repo";
import { hashPassword, verifyPassword } from "../../utils/password";
import { ApiError, CODE } from "../../utils/codes";
import { ok } from "../../utils/response";
import { assertPassword, assertOneOf, assertString, requireField } from "../../utils/validate";
import { issueTokens } from "./auth.service";
import { RefreshTokenPayload } from "../../types/auth";
import { authenticate } from "../../middleware/authenticate";

const VERIFY_CODE_TTL_SECONDS = 300; // 5 min
const VERIFY_CODE_THROTTLE_SECONDS = 120;

function maskTarget(target: string): string {
  if (target.includes("@")) {
    const [local, domain] = target.split("@");
    const visible = local.slice(0, 1);
    return `${visible}${"*".repeat(Math.max(local.length - 1, 1))}@${domain}`;
  }
  // phone: keep first 3 and last 2 digits
  return `${target.slice(0, 3)}${"*".repeat(Math.max(target.length - 5, 0))}${target.slice(-2)}`;
}

interface LoginBody {
  email?: string;
  phone?: string;
  password: string;
  device_id: string;
  device_type: number;
  device_name: string;
}

interface RefreshBody {
  refresh_token: string;
}

export default async function authRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: LoginBody }>("/auth/login", async (request) => {
    const body = request.body ?? ({} as LoginBody);
    const identifier = body.email || body.phone;
    requireField(identifier, "email or phone");
    const password = assertString(requireField(body.password, "password"), "password");
    const deviceId = assertString(requireField(body.device_id, "device_id"), "device_id");
    const deviceType = assertOneOf(
      requireField(body.device_type, "device_type"),
      [1, 2, 3, 4] as const,
      "device_type"
    );
    const deviceName = assertString(requireField(body.device_name, "device_name"), "device_name");

    const user = usersRepo.findByEmailOrPhone(identifier!.trim());
    if (!user) {
      throw new ApiError(CODE.USER_NOT_VALIDATED, "Tài khoản không tồn tại");
    }
    if (!verifyPassword(password, user.password_hash)) {
      throw new ApiError(CODE.USER_NOT_VALIDATED, "Sai mật khẩu");
    }

    devicesRepo.upsert({
      id: deviceId,
      user_id: user.id,
      device_type: deviceType,
      device_name: deviceName,
    });

    const tokens = issueTokens(app, user.id, deviceId, user.account_role);
    devicesRepo.setRefreshToken(deviceId, tokens.refresh_token);
    const device = devicesRepo.findById(deviceId)!;

    return ok({
      user: {
        id: user.id,
        first_name: user.first_name,
        last_name: user.last_name,
        email: user.email,
        phone: user.phone,
        avatar: user.avatar,
      },
      account_role: user.account_role,
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      expires_in: tokens.expires_in,
      device: {
        id: device.id,
        remote_control_enabled: device.remote_control_enabled,
      },
    });
  });

  app.post<{ Body: RefreshBody }>("/auth/refresh", async (request) => {
    const refreshToken = assertString(
      requireField(request.body?.refresh_token, "refresh_token"),
      "refresh_token"
    );

    let payload: RefreshTokenPayload;
    try {
      payload = app.jwt.verify<RefreshTokenPayload>(refreshToken);
    } catch {
      throw new ApiError(CODE.TOKEN_INVALID);
    }
    if (payload.type !== "refresh") {
      throw new ApiError(CODE.TOKEN_INVALID);
    }

    const device = devicesRepo.findById(payload.device_id);
    if (!device || device.refresh_token !== refreshToken) {
      throw new ApiError(CODE.TOKEN_INVALID, "Session revoked");
    }
    const user = usersRepo.findById(payload.sub);
    if (!user) {
      throw new ApiError(CODE.TOKEN_INVALID);
    }

    const tokens = issueTokens(app, user.id, device.id, user.account_role);
    devicesRepo.setRefreshToken(device.id, tokens.refresh_token);

    return ok(tokens);
  });

  app.post(
    "/auth/logout",
    { preHandler: authenticate },
    async (request) => {
      devicesRepo.setRefreshToken(request.auth!.deviceId, null);
      return ok({});
    }
  );

  // get_verify_code — spec § 2.1. No email/SMS provider is wired up (see
  // README "Known simplifications"); the code is logged server-side only.
  app.post<{ Body: { email?: string; phone?: string } }>(
    "/auth/verify-code",
    async (request) => {
      const body = request.body ?? {};
      const target = body.email || body.phone;
      requireField(target, "email or phone");

      const latest = verifyCodesRepo.findLatestByTarget(target!, "forgot_password");
      if (latest) {
        const elapsedSeconds = (Date.now() - new Date(latest.created_at).getTime()) / 1000;
        if (elapsedSeconds < VERIFY_CODE_THROTTLE_SECONDS) {
          throw new ApiError(CODE.ALREADY_DONE, "Vui lòng đợi trước khi gửi lại mã xác thực");
        }
      }

      const code = String(Math.floor(100000 + Math.random() * 900000));
      verifyCodesRepo.insert({
        id: randomUUID(),
        target: target!,
        purpose: "forgot_password",
        code_hash: hashPassword(code),
        expires_at: new Date(Date.now() + VERIFY_CODE_TTL_SECONDS * 1000).toISOString(),
      });
      // Simulated delivery — no email/SMS provider configured for this milestone.
      app.log.info({ target, code }, "verify code issued (not actually delivered)");

      return ok({
        expires_in: VERIFY_CODE_TTL_SECONDS,
        masked_target: maskTarget(target!),
      });
    }
  );

  // forgot_password — spec § 2.1. Consumes the verify_code and revokes every
  // device's refresh token as a safety measure after a password reset.
  app.post<{ Body: { email?: string; phone?: string; code_verify: string; new_password: string } }>(
    "/auth/password/forgot",
    async (request) => {
      const body = request.body ?? ({} as { email?: string; phone?: string; code_verify: string; new_password: string });
      const target = body.email || body.phone;
      requireField(target, "email or phone");
      const codeVerify = assertString(requireField(body.code_verify, "code_verify"), "code_verify");
      const newPassword = assertPassword(
        assertString(requireField(body.new_password, "new_password"), "new_password")
      );

      const latest = verifyCodesRepo.findLatestByTarget(target!, "forgot_password");
      if (
        !latest ||
        latest.consumed_at ||
        new Date(latest.expires_at).getTime() < Date.now() ||
        !verifyPassword(codeVerify, latest.code_hash)
      ) {
        throw new ApiError(CODE.CODE_VERIFY_INCORRECT);
      }

      const user = usersRepo.findByEmailOrPhone(target!.trim());
      if (!user) {
        throw new ApiError(CODE.USER_NOT_VALIDATED);
      }

      usersRepo.updatePassword(user.id, hashPassword(newPassword));
      verifyCodesRepo.consume(latest.id);
      devicesRepo.revokeAllForUser(user.id);

      return ok({});
    }
  );

  // change_password — spec § 2.7. Revokes every *other* device's refresh
  // token; the calling device keeps its session.
  app.put<{ Body: { old_password: string; new_password: string } }>(
    "/auth/password",
    { preHandler: authenticate },
    async (request) => {
      const body = request.body ?? ({} as { old_password: string; new_password: string });
      const oldPassword = assertString(requireField(body.old_password, "old_password"), "old_password");
      const newPassword = assertPassword(
        assertString(requireField(body.new_password, "new_password"), "new_password")
      );

      const user = usersRepo.findById(request.auth!.userId)!;
      if (!verifyPassword(oldPassword, user.password_hash)) {
        throw new ApiError(CODE.USER_NOT_VALIDATED, "Sai mật khẩu");
      }

      usersRepo.updatePassword(user.id, hashPassword(newPassword));
      devicesRepo.revokeAllForUser(user.id, request.auth!.deviceId);

      return ok({});
    }
  );
}
