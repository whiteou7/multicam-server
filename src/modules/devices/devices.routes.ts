import { FastifyInstance } from "fastify";
import { devicesRepo } from "../../db/repositories/devices.repo";
import { authenticate } from "../../middleware/authenticate";
import { ok } from "../../utils/response";
import { assertOneOf, assertString, requireField } from "../../utils/validate";

interface RegisterDeviceBody {
  device_id: string;
  device_type: number;
  device_name: string;
  model?: string;
  os_version?: string;
  capabilities?: Record<string, unknown>;
}

export default async function devicesRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: RegisterDeviceBody }>(
    "/devices",
    { preHandler: authenticate },
    async (request) => {
      const body = request.body ?? ({} as RegisterDeviceBody);
      const deviceId = assertString(requireField(body.device_id, "device_id"), "device_id");
      const deviceType = assertOneOf(
        requireField(body.device_type, "device_type"),
        [1, 2, 3, 4] as const,
        "device_type"
      );
      const deviceName = assertString(requireField(body.device_name, "device_name"), "device_name");

      devicesRepo.upsert({
        id: deviceId,
        user_id: request.auth!.userId,
        device_type: deviceType,
        device_name: deviceName,
        model: body.model,
        os_version: body.os_version,
        capabilities_json: body.capabilities ? JSON.stringify(body.capabilities) : null,
      });

      const device = devicesRepo.findById(deviceId)!;
      return ok({
        device_id: device.id,
        device_name: device.device_name,
        account_role: request.auth!.accountRole,
        remote_control_enabled: device.remote_control_enabled,
        registered_at: device.created_at,
      });
    }
  );

  app.get(
    "/devices",
    { preHandler: authenticate },
    async (request) => {
      const devices = devicesRepo.listByUser(request.auth!.userId);
      return ok({
        devices: devices.map((d) => ({
          id: d.id,
          device_name: d.device_name,
          device_type: d.device_type,
          is_online: d.is_online,
          last_seen: d.last_seen,
          is_current: d.id === request.auth!.deviceId,
        })),
        total: devices.length,
      });
    }
  );
}
