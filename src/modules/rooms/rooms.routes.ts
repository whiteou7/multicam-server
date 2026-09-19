import { FastifyInstance } from "fastify";
import { authenticate, requireRole } from "../../middleware/authenticate";
import { ApiError, CODE, MESSAGE } from "../../utils/codes";
import { ok } from "../../utils/response";
import { assertNumber, assertOneOf, assertString, requireField } from "../../utils/validate";
import * as roomsService from "./rooms.service";

interface CreateRoomBody {
  room_name?: string;
  max_members?: number;
  auto_approve?: 0 | 1;
  /** 1 = hiển thị phòng trên LAN (join không cần mã mời, xem GET /rooms/discover) */
  open_for_join?: 0 | 1;
}

interface JoinRoomBody {
  invite_code: string;
  device_id: string;
  camera_name: string;
  grant_control: boolean;
}

interface SyncRoomQuery {
  since?: string;
}

interface PermissionBody {
  grant_control: 0 | 1;
}

interface PreviewTokenBody {
  quality: "low" | "medium";
  protocol: "hls" | "webrtc";
}

interface RecordingStartBody {
  target: "all" | string[];
  config?: Record<string, unknown>;
  client_command_id: string;
}

interface RecordingStopBody {
  target: "all" | string[];
  client_command_id: string;
}

interface CameraConfigBody {
  flash_mode: "off" | "on" | "auto" | "torch";
  zoom_factor: number;
  client_command_id: string;
}

function parseTarget(target: unknown): "all" | string[] {
  requireField(target as string | undefined, "target");
  if (target === "all") return "all";
  if (Array.isArray(target) && target.every((t) => typeof t === "string")) return target;
  throw new ApiError(CODE.PARAM_TYPE_INVALID, "target must be \"all\" or an array of member_id");
}

export default async function roomsRoutes(app: FastifyInstance): Promise<void> {
  // create_room — spec § 2.8.1. Controller-only, enforced both by role and by
  // the room's owner_id (see rooms.service.requireOwnerRoom for every other route).
  app.post<{ Body: CreateRoomBody }>(
    "/rooms",
    { preHandler: [authenticate, requireRole("controller")] },
    async (request) => {
      const body = request.body ?? {};
      const roomName = body.room_name !== undefined ? assertString(body.room_name, "room_name") : null;
      let maxMembers = 8;
      if (body.max_members !== undefined) {
        maxMembers = assertNumber(body.max_members, "max_members");
        if (maxMembers < 1 || maxMembers > 50) {
          throw new ApiError(CODE.PARAM_VALUE_INVALID, "max_members must be 1-50");
        }
      }
      const autoApprove = body.auto_approve !== undefined ? assertOneOf(body.auto_approve, [0, 1] as const, "auto_approve") : 1;
      const openForJoin = body.open_for_join !== undefined ? assertOneOf(body.open_for_join, [0, 1] as const, "open_for_join") : 0;
      const result = roomsService.createRoom(request.auth!.userId, request.auth!.deviceId, roomName, maxMembers, autoApprove, openForJoin);
      return ok(result);
    }
  );

  // Public (không cần auth): danh sách phòng đang "mở trên LAN" — app dùng sau
  // khi server được /health xác minh để phone bấm vào phòng thay vì gõ mã mời.
  app.get("/rooms/discover", async () => {
    const rooms = roomsService.discoverableRooms();
    return ok(rooms.length ? rooms : []);
  });

  // join_room — spec § 2.3/2.8.2. grant_control must be exactly `true`; a
  // Remote always has the right to revoke it afterwards via set_member_permission.
  app.post<{ Body: JoinRoomBody }>(
    "/rooms/join",
    { preHandler: authenticate },
    async (request) => {
      const body = request.body ?? ({} as JoinRoomBody);
      // invite_code có thể bỏ trống — service sẽ tự chọn phòng đang "mở trên LAN"
      const inviteCode = body.invite_code ? assertString(body.invite_code, "invite_code") : "";
      const deviceId = assertString(requireField(body.device_id, "device_id"), "device_id");
      const cameraName = assertString(requireField(body.camera_name, "camera_name"), "camera_name");
      const grantControl = requireField(body.grant_control, "grant_control");
      if (grantControl !== true) {
        throw new ApiError(CODE.PARAM_VALUE_INVALID, "grant_control must be true");
      }
      if (deviceId !== request.auth!.deviceId) {
        throw new ApiError(CODE.NOT_ACCESS, "device_id must match the authenticated device");
      }
      const result = roomsService.joinRoom(request.auth!.userId, deviceId, inviteCode, cameraName);
      return ok(result);
    }
  );

  app.get<{ Params: { room_id: string } }>(
    "/rooms/:room_id/members",
    { preHandler: authenticate },
    async (request) => {
      const room = roomsService.requireOwnerRoom(request.params.room_id, request.auth!.userId);
      const members = roomsService.getRoomMembers(room);
      const pending = roomsService.getPendingMembers(room);
      if (members.length === 0 && pending.length === 0) {
        return ok({ members: [], pending: [], total: 0 }, MESSAGE[CODE.NO_DATA]);
      }
      return ok({ members, pending, total: members.length });
    }
  );

  // approve_join — owner approves a member whose join request is pending
  // (room was created with auto_approve=0).
  app.post<{ Params: { room_id: string; member_id: string } }>(
    "/rooms/:room_id/members/:member_id/approve",
    { preHandler: authenticate },
    async (request) => {
      const room = roomsService.requireOwnerRoom(request.params.room_id, request.auth!.userId);
      return ok(roomsService.approveMember(room, request.params.member_id));
    }
  );

  // deny_join — owner rejects a pending join request (device gets leave_room).
  app.post<{ Params: { room_id: string; member_id: string } }>(
    "/rooms/:room_id/members/:member_id/deny",
    { preHandler: authenticate },
    async (request) => {
      const room = roomsService.requireOwnerRoom(request.params.room_id, request.auth!.userId);
      return ok(roomsService.denyMember(room, request.params.member_id));
    }
  );

  // sync_room — spec § 1.5/2.9. Controller's periodic (3-5s) poll; `since`
  // is the revision returned by the previous call.
  app.get<{ Params: { room_id: string }; Querystring: SyncRoomQuery }>(
    "/rooms/:room_id/sync",
    { preHandler: authenticate },
    async (request) => {
      const room = roomsService.requireOwnerRoom(request.params.room_id, request.auth!.userId);
      const sinceRevision = Number(request.query.since ?? 0) || 0;
      return ok(roomsService.syncRoom(room, sinceRevision));
    }
  );

  app.post<{ Params: { room_id: string } }>(
    "/rooms/:room_id/invite-code",
    { preHandler: authenticate },
    async (request) => {
      const room = roomsService.requireOwnerRoom(request.params.room_id, request.auth!.userId);
      return ok(roomsService.refreshInviteCode(room));
    }
  );

  app.delete<{ Params: { room_id: string; member_id: string } }>(
    "/rooms/:room_id/members/:member_id",
    { preHandler: authenticate },
    async (request) => {
      const room = roomsService.requireOwnerRoom(request.params.room_id, request.auth!.userId);
      roomsService.kickMember(room, request.params.member_id);
      return ok({});
    }
  );

  app.delete<{ Params: { room_id: string } }>(
    "/rooms/:room_id",
    { preHandler: authenticate },
    async (request) => {
      const room = roomsService.requireOwnerRoom(request.params.room_id, request.auth!.userId);
      return ok(roomsService.deleteRoomHard(room));
    }
  );

  // Phòng "của tôi" (controller) — danh sách để quản lý CRUD phía controller:
  // xem mã mời, mở trên LAN, xóa phòng cũ. Owner-only.
  app.get(
    "/rooms/mine",
    { preHandler: [authenticate, requireRole("controller")] },
    async (request) => {
      return ok({ rooms: roomsService.listOwnedRooms(request.auth!.userId) });
    }
  );

  app.post<{ Params: { room_id: string } }>(
    "/rooms/:room_id/leave",
    { preHandler: authenticate },
    async (request) => {
      roomsService.leaveRoom(request.auth!.userId, request.auth!.deviceId, request.params.room_id);
      return ok({});
    }
  );

  // set_member_permission — only the Remote device that owns the membership
  // may call this; a Controller can never force-grant itself control.
  app.put<{ Params: { room_id: string; member_id: string }; Body: PermissionBody }>(
    "/rooms/:room_id/members/:member_id/permission",
    { preHandler: authenticate },
    async (request) => {
      const grantControl = assertOneOf(
        requireField(request.body?.grant_control, "grant_control"),
        [0, 1] as const,
        "grant_control"
      );
      const result = roomsService.setMemberPermission(
        request.auth!.deviceId,
        request.params.room_id,
        request.params.member_id,
        grantControl
      );
      return ok(result);
    }
  );

  app.post<{ Params: { room_id: string }; Body: PreviewTokenBody }>(
    "/rooms/:room_id/preview-token",
    { preHandler: authenticate },
    async (request) => {
      // Cho phép mọi thành viên trong phòng (owner hoặc member) lấy preview-token, không chỉ owner
      const { roomsRepo } = await import("../../db/repositories/rooms.repo");
      const { roomMembersRepo } = await import("../../db/repositories/room-members.repo");
      const room = roomsRepo.findById(request.params.room_id);
      if (!room) throw new ApiError(CODE.NOT_EXISTED);
      const isOwner = room.owner_id === request.auth!.userId;
      const isMember = !!roomMembersRepo.findActiveByRoomAndDevice(room.id, request.auth!.deviceId);
      if (!isOwner && !isMember) throw new ApiError(CODE.NOT_ACCESS, "Bạn không ở trong phòng này");
      const body = request.body ?? ({} as PreviewTokenBody);
      assertOneOf(requireField(body.quality, "quality"), ["low", "medium"] as const, "quality");
      assertOneOf(requireField(body.protocol, "protocol"), ["hls", "webrtc"] as const, "protocol");
      return ok(await roomsService.getPreviewToken(app, room));
    }
  );

  app.post<{ Params: { room_id: string }; Body: RecordingStartBody }>(
    "/rooms/:room_id/recording/start",
    { preHandler: authenticate },
    async (request) => {
      const room = roomsService.requireOwnerRoom(request.params.room_id, request.auth!.userId);
      const body = request.body ?? ({} as RecordingStartBody);
      const target = parseTarget(body.target);
      const clientCommandId = assertString(
        requireField(body.client_command_id, "client_command_id"),
        "client_command_id"
      );
      const result = roomsService.startRecording(room, target, body.config ?? {}, clientCommandId);
      return ok(result);
    }
  );

  app.post<{ Params: { room_id: string }; Body: RecordingStopBody }>(
    "/rooms/:room_id/recording/stop",
    { preHandler: authenticate },
    async (request) => {
      const room = roomsService.requireOwnerRoom(request.params.room_id, request.auth!.userId);
      const body = request.body ?? ({} as RecordingStopBody);
      const target = parseTarget(body.target);
      const clientCommandId = assertString(
        requireField(body.client_command_id, "client_command_id"),
        "client_command_id"
      );
      const result = roomsService.stopRecording(room, target, clientCommandId);
      return ok(result);
    }
  );

  app.put<{ Params: { room_id: string; member_id: string }; Body: CameraConfigBody }>(
    "/rooms/:room_id/members/:member_id/camera",
    { preHandler: authenticate },
    async (request) => {
      const room = roomsService.requireOwnerRoom(request.params.room_id, request.auth!.userId);
      const body = request.body ?? ({} as CameraConfigBody);
      const flashMode = assertOneOf(
        requireField(body.flash_mode, "flash_mode"),
        ["off", "on", "auto", "torch"] as const,
        "flash_mode"
      );
      const zoomFactor = assertNumber(requireField(body.zoom_factor, "zoom_factor"), "zoom_factor");
      if (zoomFactor < 0.5 || zoomFactor > 10.0) {
        throw new ApiError(CODE.PARAM_VALUE_INVALID, "zoom_factor must be 0.5-10.0");
      }
      const clientCommandId = assertString(
        requireField(body.client_command_id, "client_command_id"),
        "client_command_id"
      );
      const result = roomsService.setCameraConfig(
        room,
        request.params.member_id,
        flashMode,
        zoomFactor,
        clientCommandId
      );
      return ok(result);
    }
  );

  app.get<{ Params: { room_id: string; member_id: string } }>(
    "/rooms/:room_id/members/:member_id/camera",
    { preHandler: authenticate },
    async (request) => {
      const room = roomsService.requireOwnerRoom(request.params.room_id, request.auth!.userId);
      return ok(roomsService.getCameraConfig(room, request.params.member_id));
    }
  );
}
