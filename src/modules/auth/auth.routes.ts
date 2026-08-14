import { FastifyInstance } from "fastify";
import { usersRepo } from "../../db/repositories/users.repo";
import { devicesRepo } from "../../db/repositories/devices.repo";
import { verifyPassword } from "../../utils/password";
import { ApiError, CODE } from "../../utils/codes";
import { ok } from "../../utils/response";
import { assertOneOf, assertString, requireField } from "../../utils/validate";
import { issueTokens } from "./auth.service";
import { RefreshTokenPayload } from "../../types/auth";
import { authenticate } from "../../middleware/authenticate";

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
}
