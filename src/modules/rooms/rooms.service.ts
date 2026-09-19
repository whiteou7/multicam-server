import { randomUUID } from "node:crypto";
import { FastifyInstance } from "fastify";
import { devicesRepo } from "../../db/repositories/devices.repo";
import { deviceCommandsRepo } from "../../db/repositories/device-commands.repo";
import { recordingSessionsRepo } from "../../db/repositories/recording-sessions.repo";
import { RoomMemberRow, roomMembersRepo } from "../../db/repositories/room-members.repo";
import { RoomRow, roomsRepo } from "../../db/repositories/rooms.repo";
import { ApiError, CODE } from "../../utils/codes";
import { closeMemberMedia, closeRoomMedia, getOrCreateRoomMedia } from "../media/media.service";

const INVITE_CODE_CHARSET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I
const INVITE_CODE_TTL_MS = 10 * 60 * 1000; // 10 min
const PREVIEW_TOKEN_TTL_SECONDS = 300; // 5 min
const DEFAULT_ZOOM_RANGE = { min: 0.5, max: 10.0 };

export function generateInviteCode(): string {
  let code = "";
  for (let i = 0; i < 6; i++) {
    code += INVITE_CODE_CHARSET[Math.floor(Math.random() * INVITE_CODE_CHARSET.length)];
  }
  return code;
}

function memberPublicShape(m: RoomMemberRow) {
  return {
    member_id: m.id,
    device_id: m.device_id,
    camera_name: m.camera_name,
    is_online: m.is_online,
    has_granted_control: m.has_granted_control,
    battery_level: m.battery_level,
    is_charging: m.is_charging,
    storage_free: m.storage_free,
    temperature_state: m.temperature_state,
    recording_state: m.recording_state,
    elapsed_ms: m.elapsed_ms,
    upload_state: m.upload_state,
    upload_percent: m.upload_percent,
    error_code: m.error_code,
    join_status: m.join_status,
    // Not a per-member field in the mediasoup model — call get_preview_token
    // once for router rtp_capabilities + the room's WS signaling endpoint,
    // then consume each member's producer as it announces itself.
    preview_url: null,
    last_seen: m.last_seen,
  };
}

export function requireOwnerRoom(roomId: string, userId: string): RoomRow {
  const room = roomsRepo.findById(roomId);
  if (!room) throw new ApiError(CODE.NOT_EXISTED);
  if (room.owner_id !== userId) throw new ApiError(CODE.NOT_ACCESS);
  return room;
}

export function createRoom(
  ownerUserId: string,
  ownerDeviceId: string,
  roomName: string | null,
  maxMembers: number,
  autoApprove = 1,
  openForJoin = 0
) {
  const device = devicesRepo.findById(ownerDeviceId);
  if (!device || device.user_id !== ownerUserId) {
    throw new ApiError(CODE.NOT_EXISTED);
  }
  if (device.remote_control_enabled !== 1) {
    throw new ApiError(CODE.LIMITED_ACCESS, "Chưa bật Remote Camera Control");
  }

  const existing = roomsRepo.findOpenByOwner(ownerUserId);
  if (existing) {
    if (existing.open_for_join !== openForJoin) {
      roomsRepo.setOpenForJoin(existing.id, openForJoin);
      roomsRepo.bumpRevision(existing.id);
      existing.open_for_join = openForJoin;
    }
    ensureOwnerMember(existing, ownerUserId, ownerDeviceId);
    consolidateOwnedRooms(ownerUserId, existing.id);
    return {
      room_id: existing.id,
      invite_code: existing.invite_code,
      expires_at: existing.invite_code_expires_at,
      owner_device_id: existing.owner_device_id,
      open_for_join: existing.open_for_join,
      created_at: existing.created_at,
    };
  }

  const id = randomUUID();
  const inviteCode = generateInviteCode();
  const expiresAt = new Date(Date.now() + INVITE_CODE_TTL_MS).toISOString();
  roomsRepo.insert({
    id,
    owner_id: ownerUserId,
    owner_device_id: ownerDeviceId,
    room_name: roomName,
    invite_code: inviteCode,
    invite_code_expires_at: expiresAt,
    max_members: maxMembers,
    auto_approve: autoApprove,
    open_for_join: openForJoin,
  });
  const room = roomsRepo.findById(id)!;
  ensureOwnerMember(room, ownerUserId, ownerDeviceId);
  consolidateOwnedRooms(ownerUserId, room.id);
  return {
    room_id: room.id,
    invite_code: room.invite_code,
    expires_at: room.invite_code_expires_at,
    owner_device_id: room.owner_device_id,
    open_for_join: room.open_for_join,
    created_at: room.created_at,
  };
}

/**
 * Controller chỉ nên có MỘT phòng duy nhất để không mọc ra loạt phòng cũ lộn xộn
 * trên LAN. Khi tạo/dùng lại phòng, xóa hẳn (hard-delete) mọi phòng khác của user:
 * - các phòng OWNED đang mở khác (remote kẹt ở đó sẽ tự thoát membership),
 * - các phòng kín/đã đóng cũ không còn dùng (dọn sạch hàng rác tích lũy).
 */
function consolidateOwnedRooms(ownerUserId: string, keepRoomId: string): void {
  for (const owned of roomsRepo.listOwned(ownerUserId)) {
    if (owned.id === keepRoomId) continue;
    try {
      closeRoomMedia(owned.id);
    } catch {
      /* room media có thể chưa tồn tại */
    }
    roomsRepo.deleteRoom(owned.id);
  }
}

export function listOwnedRooms(userId: string) {
  return roomsRepo.listOwned(userId).map((room) => {
    const active = roomMembersRepo.listAllByRoom(room.id).filter((m) => !m.left_at);
    return {
      room_id: room.id,
      room_name: room.room_name,
      invite_code: room.invite_code,
      open_for_join: room.open_for_join,
      auto_approve: room.auto_approve,
      status: room.status,
      member_count: active.filter((m) => m.join_status === "approved").length,
      max_members: room.max_members,
      created_at: room.created_at,
    };
  });
}

/** Xóa hẳn phòng (owner): đóng media trước, rồi hard-delete (FK cascade dọn members). */
export function deleteRoomHard(room: RoomRow): void {
  try {
    closeRoomMedia(room.id);
  } catch {
    /* chưa có media */
  }
  roomsRepo.deleteRoom(room.id);
}

/**
 * Chủ phòng (controller) luôn là thành viên chính phòng của mình: bấm "Rời phòng"
 * ở app/dashboard controller sẽ hoạt động (trước đây owner không phải member nên
 * leave bị NOT_ACCESS "không được rời phòng"). Nếu device chủ đang kẹt ở phòng
 * khác thì tự rời phòng đó để vào phòng mình vừa tạo.
 */
function ensureOwnerMember(room: RoomRow, ownerUserId: string, ownerDeviceId: string): void {
  const existing = roomMembersRepo.findActiveByDevice(ownerDeviceId);
  if (existing && existing.room_id === room.id) return;
  if (existing) {
    const rev = roomsRepo.bumpRevision(existing.room_id);
    roomMembersRepo.setLeft(existing.id, rev);
    closeMemberMedia(existing.room_id, existing.id);
  }
  if (roomMembersRepo.findActiveByRoomAndDevice(room.id, ownerDeviceId)) return;
  const revision = roomsRepo.bumpRevision(room.id);
  const ownerDevice = devicesRepo.findById(ownerDeviceId);
  roomMembersRepo.insert({
    id: randomUUID(),
    room_id: room.id,
    device_id: ownerDeviceId,
    user_id: ownerUserId,
    camera_name: ownerDevice?.camera_name ?? `Controller-${ownerDeviceId.slice(0, 4)}`,
    joined_revision: revision,
    join_status: "approved",
  });
}

/** Danh sách phòng đang "mở trên LAN" cho bất kỳ ai trong cùng subnet join (không cần mã). */
export function discoverableRooms() {
  return roomsRepo.listOpenRooms().map((room) => {
    const active = roomMembersRepo.listAllByRoom(room.id).filter((m) => !m.left_at);
    return {
      room_id: room.id,
      room_name: room.room_name,
      invite_code: room.invite_code,
      auto_approve: room.auto_approve,
      member_count: active.filter((m) => m.join_status === "approved").length,
      pending_count: active.filter((m) => m.join_status === "pending").length,
      max_members: room.max_members,
    };
  });
}

export function joinRoom(
  userId: string,
  deviceId: string,
  inviteCode: string,
  cameraName: string
) {
  const device = devicesRepo.findById(deviceId);
  if (!device || device.user_id !== userId) {
    throw new ApiError(CODE.NOT_EXISTED);
  }

  let room = roomsRepo.findOpenByInviteCode(inviteCode);
  // Chế độ LAN: app gửi mã mời từ discovery payload. Nếu để trống mã mà có phòng
  // đang mở trên LAN (open_for_join=1) thì tự chọn phòng mở đó.
  if (!room && !inviteCode) {
    room = roomsRepo.listOpenRooms()[0];
  }
  if (!room || (room.open_for_join !== 1 && new Date(room.invite_code_expires_at).getTime() < Date.now())) {
    throw new ApiError(CODE.NOT_EXISTED, "Mã mời không tồn tại hoặc đã hết hạn");
  }
  const existingMember = roomMembersRepo.findActiveByDevice(deviceId);
  if (existingMember) {
    // Idempotent: device đã ở CHÍNH phòng này (vd tự join lại khi mở lại app) thì
    // xem như đã join — không báo lỗi. Chỉ báo 409 khi device đang ở phòng KHÁC.
    if (existingMember.room_id === room.id) {
      const ownerDevice = devicesRepo.findById(room.owner_device_id);
      const members = roomMembersRepo.listActiveByRoom(room.id).map(memberPublicShape);
      return {
        room_id: room.id,
        room_name: room.room_name,
        owner: { device_id: room.owner_device_id, camera_name: ownerDevice?.camera_name ?? null },
        member_id: existingMember.id,
        member_join_status: existingMember.join_status,
        members,
        already_in_room: true,
      };
    }
    throw new ApiError(CODE.ALREADY_DONE, "Thiết bị đã ở trong một phòng khác");
  }
  const activeMembers = roomMembersRepo.listAllByRoom(room.id).filter((m) => !m.left_at);
  if (activeMembers.length >= room.max_members) {
    throw new ApiError(CODE.MAX_ITEMS_EXCEEDED, "Phòng đã đủ thành viên");
  }

  const revision = roomsRepo.bumpRevision(room.id);
  const memberId = randomUUID();
  const joinStatus = room.auto_approve === 0 ? "pending" : "approved";
  roomMembersRepo.insert({
    id: memberId,
    room_id: room.id,
    device_id: deviceId,
    user_id: userId,
    camera_name: cameraName,
    joined_revision: revision,
    join_status: joinStatus,
  });

  const ownerDevice = devicesRepo.findById(room.owner_device_id);
  const members = roomMembersRepo.listActiveByRoom(room.id).map(memberPublicShape);

  return {
    room_id: room.id,
    room_name: room.room_name,
    owner: { device_id: room.owner_device_id, camera_name: ownerDevice?.camera_name ?? null },
    member_id: memberId,
    member_join_status: joinStatus,
    members,
  };
}

export function getRoomMembers(room: RoomRow) {
  return roomMembersRepo.listActiveByRoom(room.id).map(memberPublicShape);
}

export function getPendingMembers(room: RoomRow) {
  return roomMembersRepo.listPendingByRoom(room.id).map(memberPublicShape);
}

export function syncRoom(room: RoomRow, sinceRevision: number) {
  const activeSession = recordingSessionsRepo.findActiveByRoom(room.id);
  const members = roomMembersRepo.listActiveByRoom(room.id).map(memberPublicShape);
  const pending = roomMembersRepo.listPendingByRoom(room.id).map(memberPublicShape);
  const joined = roomMembersRepo.listJoinedSince(room.id, sinceRevision)
    .filter((m) => m.join_status === "approved")
    .map(memberPublicShape);
  const left = roomMembersRepo.listLeftSince(room.id, sinceRevision).map((m) => m.id);

  return {
    server_time: new Date().toISOString(),
    revision: room.revision,
    next_sync_in: activeSession ? 3 : 5,
    room: {
      status: room.status,
      session_id: room.session_id,
      started_at: activeSession?.started_at ?? null,
    },
    members,
    pending,
    joined,
    left,
  };
}

export function refreshInviteCode(room: RoomRow) {
  const inviteCode = generateInviteCode();
  const expiresAt = new Date(Date.now() + INVITE_CODE_TTL_MS).toISOString();
  roomsRepo.setInviteCode(room.id, inviteCode, expiresAt);
  roomsRepo.bumpRevision(room.id);
  return { invite_code: inviteCode, expires_at: expiresAt };
}

export function kickMember(room: RoomRow, memberId: string) {
  const member = roomMembersRepo.findById(memberId);
  if (!member || member.room_id !== room.id || member.left_at) {
    throw new ApiError(CODE.NOT_EXISTED);
  }
  const revision = roomsRepo.bumpRevision(room.id);
  roomMembersRepo.setLeft(memberId, revision);
  closeMemberMedia(room.id, memberId);
  deviceCommandsRepo.insert({
    id: randomUUID(),
    device_id: member.device_id,
    room_id: room.id,
    member_id: memberId,
    type: "leave_room",
    payload_json: JSON.stringify({ reason: "kicked" }),
  });
}

export function approveMember(room: RoomRow, memberId: string) {
  const member = roomMembersRepo.findById(memberId);
  if (!member || member.room_id !== room.id || member.left_at) {
    throw new ApiError(CODE.NOT_EXISTED);
  }
  if (member.join_status !== "pending") {
    throw new ApiError(CODE.ALREADY_DONE, "Thiết bị này không ở trạng thái chờ duyệt");
  }
  roomMembersRepo.setJoinStatus(memberId, "approved");
  roomsRepo.bumpRevision(room.id);
  // Báo cho Remote biết đã được duyệt (được đưa vào danh sách pending_commands).
  deviceCommandsRepo.insert({
    id: randomUUID(),
    device_id: member.device_id,
    room_id: room.id,
    member_id: memberId,
    type: "join_approved",
    payload_json: JSON.stringify({ room_id: room.id }),
  });
  const approved = roomMembersRepo.findById(memberId)!;
  return { member: memberPublicShape(approved) };
}

export function denyMember(room: RoomRow, memberId: string) {
  const member = roomMembersRepo.findById(memberId);
  if (!member || member.room_id !== room.id || member.left_at) {
    throw new ApiError(CODE.NOT_EXISTED);
  }
  if (member.join_status !== "pending") {
    throw new ApiError(CODE.ALREADY_DONE, "Thiết bị này không ở trạng thái chờ duyệt");
  }
  const revision = roomsRepo.bumpRevision(room.id);
  roomMembersRepo.setJoinStatus(memberId, "denied");
  roomMembersRepo.setLeft(memberId, revision);
  closeMemberMedia(room.id, memberId);
  deviceCommandsRepo.insert({
    id: randomUUID(),
    device_id: member.device_id,
    room_id: room.id,
    member_id: memberId,
    type: "leave_room",
    payload_json: JSON.stringify({ reason: "denied" }),
  });
  return { member_id: memberId, join_status: "denied" };
}

export function closeRoom(room: RoomRow) {
  const activeSession = recordingSessionsRepo.findActiveByRoom(room.id);
  const sessionStopped = !!activeSession;

  const members = roomMembersRepo.listActiveByRoom(room.id);
  for (const member of members) {
    if (activeSession) {
      deviceCommandsRepo.insert({
        id: randomUUID(),
        device_id: member.device_id,
        room_id: room.id,
        member_id: member.id,
        type: "stop_record",
        payload_json: JSON.stringify({ session_id: activeSession.id, reason: "room_closed" }),
      });
    }
    deviceCommandsRepo.insert({
      id: randomUUID(),
      device_id: member.device_id,
      room_id: room.id,
      member_id: member.id,
      type: "leave_room",
      payload_json: JSON.stringify({ reason: "room_closed" }),
    });
    const revision = roomsRepo.bumpRevision(room.id);
    roomMembersRepo.setLeft(member.id, revision);
  }

  if (activeSession) {
    recordingSessionsRepo.setStopped(activeSession.id);
  }
  roomsRepo.setSessionId(room.id, null);
  roomsRepo.close(room.id);
  closeRoomMedia(room.id);

  return {
    closed_at: new Date().toISOString(),
    session_stopped: sessionStopped ? 1 : 0,
  };
}

export function leaveRoom(userId: string, deviceId: string, roomId: string) {
  const member = roomMembersRepo.findActiveByRoomAndDevice(roomId, deviceId);
  if (!member || member.user_id !== userId) {
    throw new ApiError(CODE.NOT_ACCESS);
  }
  const revision = roomsRepo.bumpRevision(roomId);
  roomMembersRepo.setLeft(member.id, revision);
  closeMemberMedia(roomId, member.id);
}

export function setMemberPermission(
  deviceId: string,
  roomId: string,
  memberId: string,
  grantControl: 0 | 1
) {
  const member = roomMembersRepo.findById(memberId);
  if (!member || member.room_id !== roomId || member.left_at) {
    throw new ApiError(CODE.NOT_EXISTED);
  }
  if (member.device_id !== deviceId) {
    throw new ApiError(CODE.NOT_ACCESS);
  }
  roomMembersRepo.setControl(memberId, grantControl);
  roomsRepo.bumpRevision(roomId);
  return { member_id: memberId, has_granted_control: grantControl };
}

// Hands back what a client needs to open the mediasoup signaling socket:
// the room's router rtp_capabilities (so it knows what it can send/receive)
// and the WS path itself. Actual per-member streams arrive as "new-producer"
// events over that socket as each Remote starts producing, not as a list
// here — a Remote may join/produce after this token was issued.
export async function getPreviewToken(app: FastifyInstance, room: RoomRow) {
  const members = roomMembersRepo.listActiveByRoom(room.id);
  const roomMedia = await getOrCreateRoomMedia(app, room.id);
  return {
    preview_token: randomUUID(),
    expires_in: PREVIEW_TOKEN_TTL_SECONDS,
    signaling_url: `/it4788/api/v1/rooms/${room.id}/media`,
    rtp_capabilities: roomMedia.router.rtpCapabilities,
    streams: members.map((m) => ({ member_id: m.id, is_online: m.is_online })),
  };
}

function resolveTargetMembers(room: RoomRow, target: "all" | string[]): RoomMemberRow[] {
  const active = roomMembersRepo.listActiveByRoom(room.id);
  if (target === "all") return active;
  const ids = new Set(target);
  return active.filter((m) => ids.has(m.id));
}

export function startRecording(
  room: RoomRow,
  target: "all" | string[],
  config: Record<string, unknown>,
  clientCommandId: string
) {
  if (recordingSessionsRepo.findActiveByRoom(room.id)) {
    throw new ApiError(CODE.ALREADY_DONE, "Đang quay rồi");
  }

  const candidates = resolveTargetMembers(room, target);
  const accepted: RoomMemberRow[] = [];
  const rejected: { member_id: string; reason: string }[] = [];
  for (const member of candidates) {
    if (!member.is_online) {
      rejected.push({ member_id: member.id, reason: "offline" });
    } else if (!member.has_granted_control) {
      rejected.push({ member_id: member.id, reason: "no_control" });
    } else {
      accepted.push(member);
    }
  }
  if (accepted.length === 0) {
    throw new ApiError(CODE.COULD_NOT_COMPLETE, "Không có máy nào online để bắt đầu quay");
  }

  const sessionId = randomUUID();
  recordingSessionsRepo.insert({ id: sessionId, room_id: room.id, config_json: JSON.stringify(config) });
  roomsRepo.setSessionId(room.id, sessionId);

  for (const member of accepted) {
    deviceCommandsRepo.insert({
      id: randomUUID(),
      device_id: member.device_id,
      room_id: room.id,
      member_id: member.id,
      type: "start_record",
      payload_json: JSON.stringify({ session_id: sessionId, config, client_command_id: clientCommandId }),
    });
    roomMembersRepo.updateTelemetry(member.id, { recording_state: "accepted" });
  }
  roomsRepo.bumpRevision(room.id);

  const session = recordingSessionsRepo.findById(sessionId)!;
  return {
    session_id: sessionId,
    started_at: session.started_at,
    command_id: clientCommandId,
    targets: accepted.map((m) => m.id),
    rejected,
  };
}

export function stopRecording(room: RoomRow, target: "all" | string[], clientCommandId: string) {
  const session = recordingSessionsRepo.findActiveByRoom(room.id);
  if (!session) {
    throw new ApiError(CODE.NOT_EXISTED, "Không có phiên quay đang diễn ra");
  }

  const members = resolveTargetMembers(room, target);
  const results = members.map((member) => {
    deviceCommandsRepo.insert({
      id: randomUUID(),
      device_id: member.device_id,
      room_id: room.id,
      member_id: member.id,
      type: "stop_record",
      payload_json: JSON.stringify({ session_id: session.id, client_command_id: clientCommandId }),
    });
    return {
      member_id: member.id,
      local_video_uid: null as string | null,
      duration: null as number | null,
      size: null as number | null,
      // Final state lands async via that member's next sync_device call —
      // poll sync_room or get_recording_session to see it resolve.
      status: "stop_queued",
    };
  });

  recordingSessionsRepo.setStopped(session.id);
  roomsRepo.setSessionId(room.id, null);
  roomsRepo.bumpRevision(room.id);

  return { session_id: session.id, stopped_at: new Date().toISOString(), results };
}

function requireActiveMember(roomId: string, memberId: string): RoomMemberRow {
  const member = roomMembersRepo.findById(memberId);
  if (!member || member.room_id !== roomId || member.left_at) {
    throw new ApiError(CODE.NOT_EXISTED);
  }
  return member;
}

export function setCameraConfig(
  room: RoomRow,
  memberId: string,
  flashMode: string,
  zoomFactor: number,
  clientCommandId: string
) {
  const member = requireActiveMember(room.id, memberId);
  roomMembersRepo.setCamera(memberId, flashMode, zoomFactor);
  deviceCommandsRepo.insert({
    id: randomUUID(),
    device_id: member.device_id,
    room_id: room.id,
    member_id: memberId,
    type: "camera_config",
    payload_json: JSON.stringify({ flash_mode: flashMode, zoom_factor: zoomFactor, client_command_id: clientCommandId }),
  });
  roomsRepo.bumpRevision(room.id);
  return { member_id: memberId, flash_mode: flashMode, zoom_factor: zoomFactor, applied_at: new Date().toISOString() };
}

export function getCameraConfig(room: RoomRow, memberId: string) {
  const member = requireActiveMember(room.id, memberId);
  const device = devicesRepo.findById(member.device_id);
  const capabilities = device?.capabilities_json ? JSON.parse(device.capabilities_json) : {};
  return {
    flash_mode: member.flash_mode,
    zoom_factor: member.zoom_factor,
    zoom_range: {
      min: capabilities.zoom_min ?? DEFAULT_ZOOM_RANGE.min,
      max: capabilities.zoom_max ?? DEFAULT_ZOOM_RANGE.max,
    },
    has_flash: capabilities.has_flash ?? 1,
  };
}
