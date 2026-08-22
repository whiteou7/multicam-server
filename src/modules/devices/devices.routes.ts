import { FastifyInstance } from "fastify";
import { devicesRepo } from "../../db/repositories/devices.repo";
import { deviceCommandsRepo } from "../../db/repositories/device-commands.repo";
import { roomMembersRepo } from "../../db/repositories/room-members.repo";
import { roomsRepo } from "../../db/repositories/rooms.repo";
import { authenticate } from "../../middleware/authenticate";
import { ApiError, CODE } from "../../utils/codes";
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

interface SetDeviceConfigBody {
  remote_control_enabled?: number;
  camera_name?: string;
}

interface SetDevtokenBody {
  devtype: number;
  devtoken: string;
}

interface SyncDeviceBody {
  battery_level?: number;
  is_charging?: number;
  storage_free?: number;
  temperature_state?: string;
  camera_permission?: number;
  mic_permission?: number;
  recording_state?: string;
  elapsed_ms?: number;
  local_video_uid?: string;
  upload_state?: string;
  upload_percent?: number;
  error_code?: string;
  last_command_id?: string;
}

function requireOwnDevice(deviceId: string, userId: string) {
  const device = devicesRepo.findById(deviceId);
  if (!device || device.user_id !== userId) {
    throw new ApiError(CODE.NOT_EXISTED);
  }
  return device;
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

  // set_device_config — spec § 2.7. remote_control_enabled can't be turned off
  // while the device is an active room member (must leave the room first).
  app.put<{ Params: { device_id: string }; Body: SetDeviceConfigBody }>(
    "/devices/:device_id",
    { preHandler: authenticate },
    async (request) => {
      const device = requireOwnDevice(request.params.device_id, request.auth!.userId);
      const body = request.body ?? {};

      let remoteControlEnabled: number | undefined;
      if (body.remote_control_enabled !== undefined) {
        remoteControlEnabled = assertOneOf(body.remote_control_enabled, [0, 1] as const, "remote_control_enabled");
        if (remoteControlEnabled === 0) {
          const activeMembership = roomMembersRepo.findActiveByDevice(device.id);
          if (activeMembership) {
            throw new ApiError(CODE.LIMITED_ACCESS, "Đang ở trong phòng nên không tắt được Remote Camera Control");
          }
        }
      }
      let cameraName: string | undefined;
      if (body.camera_name !== undefined) {
        cameraName = assertString(body.camera_name, "camera_name");
        if (cameraName.length === 0 || cameraName.length > 32) {
          throw new ApiError(CODE.PARAM_VALUE_INVALID, "camera_name must be 1-32 characters");
        }
      }

      devicesRepo.setConfig(device.id, {
        remote_control_enabled: remoteControlEnabled,
        camera_name: cameraName,
      });
      const updated = devicesRepo.findById(device.id)!;
      return ok({
        device_id: updated.id,
        remote_control_enabled: updated.remote_control_enabled,
        camera_name: updated.camera_name,
      });
    }
  );

  // delete_device — revokes a remote session; that device picks up
  // session_revoked = 1 on its next sync_device/refresh call.
  app.delete<{ Params: { device_id: string } }>(
    "/devices/:device_id",
    { preHandler: authenticate },
    async (request) => {
      requireOwnDevice(request.params.device_id, request.auth!.userId);
      devicesRepo.revokeSession(request.params.device_id);
      return ok({});
    }
  );

  // set_devtoken — spec § 2.1/2.7. Web devices don't get push notifications.
  app.put<{ Params: { device_id: string }; Body: SetDevtokenBody }>(
    "/devices/:device_id/push-token",
    { preHandler: authenticate },
    async (request) => {
      const device = requireOwnDevice(request.params.device_id, request.auth!.userId);
      if (device.device_type === 4) {
        throw new ApiError(CODE.LIMITED_ACCESS, "Thiết bị Web không gọi được set_devtoken");
      }
      const body = request.body ?? ({} as SetDevtokenBody);
      const devtype = assertOneOf(requireField(body.devtype, "devtype"), [1, 2] as const, "devtype");
      const devtoken = assertString(requireField(body.devtoken, "devtoken"), "devtoken");
      devicesRepo.setPushToken(device.id, devtype, devtoken);
      return ok({});
    }
  );

  // sync_device — spec § 1.5/2.3: periodic (3-5s) heartbeat + command pickup.
  // Delivers pending_commands in place of the deferred command-push socket.
  app.post<{ Params: { device_id: string }; Body: SyncDeviceBody }>(
    "/devices/:device_id/sync",
    { preHandler: authenticate },
    async (request) => {
      const device = requireOwnDevice(request.params.device_id, request.auth!.userId);
      const body = request.body ?? ({} as SyncDeviceBody);

      const member = roomMembersRepo.findActiveByDevice(device.id);
      if (member) {
        roomMembersRepo.updateTelemetry(member.id, {
          battery_level: body.battery_level,
          is_charging: body.is_charging,
          storage_free: body.storage_free,
          temperature_state: body.temperature_state,
          recording_state: body.recording_state,
          elapsed_ms: body.elapsed_ms,
          upload_state: body.upload_state,
          upload_percent: body.upload_percent,
          error_code: body.error_code,
          last_command_id: body.last_command_id,
        });
        roomsRepo.bumpRevision(member.room_id);
      }

      if (body.last_command_id) {
        deviceCommandsRepo.ackUpTo(device.id, body.last_command_id);
      }

      const pendingCommands = deviceCommandsRepo.listPendingForDevice(device.id).map((c) => ({
        command_id: c.id,
        type: c.type,
        payload: JSON.parse(c.payload_json),
        issued_at: c.issued_at,
      }));

      const sessionRevoked = device.session_revoked === 1;
      if (sessionRevoked) {
        devicesRepo.setSessionRevoked(device.id, 0);
      }

      const room = member ? roomsRepo.findById(member.room_id) : undefined;
      const isRecording = !!(room && room.session_id);

      return ok({
        server_time: new Date().toISOString(),
        next_sync_in: isRecording ? 3 : 5,
        room_status: {
          in_room: member ? 1 : 0,
          room_id: member?.room_id ?? null,
          session_id: room?.session_id ?? null,
        },
        pending_commands: pendingCommands,
        session_revoked: sessionRevoked ? 1 : 0,
      });
    }
  );
}
