import { db } from "../index";

export interface RoomRow {
  id: string;
  owner_id: string;
  owner_device_id: string;
  room_name: string | null;
  invite_code: string;
  invite_code_expires_at: string;
  max_members: number;
  auto_approve: number;
  open_for_join: number;
  status: "open" | "closed";
  session_id: string | null;
  revision: number;
  created_at: string;
  closed_at: string | null;
}

export const roomsRepo = {
  insert(room: {
    id: string;
    owner_id: string;
    owner_device_id: string;
    room_name: string | null;
    invite_code: string;
    invite_code_expires_at: string;
    max_members: number;
    auto_approve?: number;
    open_for_join?: number;
  }): void {
    db.prepare(
      `INSERT INTO rooms (id, owner_id, owner_device_id, room_name, invite_code, invite_code_expires_at, max_members, auto_approve, open_for_join)
       VALUES (@id, @owner_id, @owner_device_id, @room_name, @invite_code, @invite_code_expires_at, @max_members, @auto_approve, @open_for_join)`
    ).run({
      ...room,
      auto_approve: room.auto_approve ?? 1,
      open_for_join: room.open_for_join ?? 0,
    });
  },

  findById(id: string): RoomRow | undefined {
    return db.prepare<[string]>("SELECT * FROM rooms WHERE id = ?").get(id) as RoomRow | undefined;
  },

  findOpenByOwner(ownerId: string): RoomRow | undefined {
    return db
      .prepare<[string]>("SELECT * FROM rooms WHERE owner_id = ? AND status = 'open' LIMIT 1")
      .get(ownerId) as RoomRow | undefined;
  },

  findOpenByInviteCode(code: string): RoomRow | undefined {
    return db
      .prepare<[string]>("SELECT * FROM rooms WHERE invite_code = ? AND status = 'open' LIMIT 1")
      .get(code) as RoomRow | undefined;
  },

  /** Phòng đang mở và được đánh dấu "tìm thấy trên LAN" (join không cần mã mời). */
  listOpenRooms(): RoomRow[] {
    return db
      .prepare(
        "SELECT * FROM rooms WHERE status = 'open' AND open_for_join = 1 ORDER BY created_at DESC LIMIT 20"
      )
      .all() as RoomRow[];
  },

  setOpenForJoin(id: string, open: number): void {
    db.prepare("UPDATE rooms SET open_for_join = ? WHERE id = ?").run(open, id);
  },

  /** Toàn bộ phòng của một user (mở + đã đóng), mới nhất trước. */
  listOwned(ownerId: string): RoomRow[] {
    return db
      .prepare<[string]>(
        "SELECT * FROM rooms WHERE owner_id = ? ORDER BY (status = 'open') DESC, created_at DESC"
      )
      .all(ownerId) as RoomRow[];
  },

  /** Xóa hẳn phòng (FK ON DELETE CASCADE dọn room_members/device_commands/recording_sessions). */
  deleteRoom(id: string): void {
    db.prepare("DELETE FROM rooms WHERE id = ?").run(id);
  },

  bumpRevision(id: string): number {
    db.prepare("UPDATE rooms SET revision = revision + 1 WHERE id = ?").run(id);
    const row = db.prepare<[string]>("SELECT revision FROM rooms WHERE id = ?").get(id) as
      | { revision: number }
      | undefined;
    return row?.revision ?? 0;
  },

  setInviteCode(id: string, code: string, expiresAt: string): void {
    db.prepare("UPDATE rooms SET invite_code = ?, invite_code_expires_at = ? WHERE id = ?").run(
      code,
      expiresAt,
      id
    );
  },

  setSessionId(id: string, sessionId: string | null): void {
    db.prepare("UPDATE rooms SET session_id = ? WHERE id = ?").run(sessionId, id);
  },

  close(id: string): void {
    db.prepare(
      "UPDATE rooms SET status = 'closed', closed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?"
    ).run(id);
  },
};
