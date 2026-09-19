import { randomUUID } from "node:crypto";
import { env } from "../../config/env";
import { usersRepo } from "../../db/repositories/users.repo";
import { roomsRepo } from "../../db/repositories/rooms.repo";
import { generateInviteCode } from "./rooms.service";

/** Hạn mã mời của phòng chung: đặt cực xa (~100 năm) = không giới hạn thời gian.
 *  Bản thân joinRoom cũng bỏ qua hạn nếu phòng open_for_join=1. */
const DEFAULT_ROOM_INVITE_TTL_MS = 100 * 365 * 24 * 60 * 60 * 1000;

/**
 * Đảm bảo tồn tại "phòng chung" của server:
 * - Tạo 1 lần khi khởi động (idempotent — phòng đang mở thì giữ nguyên, không reset).
 * - Mở trên LAN (open_for_join=1) → trả về qua GET /rooms/discover, join không cần mã.
 * - Không giới hạn thời gian: không có cơ chế auto-close, hạn mã mời rất xa,
 *   và joinRoom bỏ qua hạn hẹn với phòng mở.
 */
export function ensureDefaultRoom(): { room_id: string; invite_code: string } | null {
  if (!env.rooms.defaultRoomEnabled) return null;

  const owner = usersRepo.findByEmailOrPhone(env.rooms.defaultOwnerEmail);
  if (!owner) return null;

  const existing = roomsRepo.findOpenByOwner(owner.id);
  if (existing) {
    if (existing.open_for_join !== 1) {
      roomsRepo.setOpenForJoin(existing.id, 1);
      roomsRepo.bumpRevision(existing.id);
    }
    return { room_id: existing.id, invite_code: existing.invite_code };
  }

  const id = randomUUID();
  roomsRepo.insert({
    id,
    owner_id: owner.id,
    owner_device_id: "default-room-device",
    room_name: env.rooms.defaultRoomName,
    invite_code: generateInviteCode(),
    invite_code_expires_at: new Date(Date.now() + DEFAULT_ROOM_INVITE_TTL_MS).toISOString(),
    max_members: env.rooms.defaultRoomMaxMembers,
    auto_approve: env.rooms.defaultRoomAutoApprove ? 1 : 0,
    open_for_join: 1,
  });
  const room = roomsRepo.findById(id)!;

  return { room_id: room.id, invite_code: room.invite_code };
}