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
  }): void {
    db.prepare(
      `INSERT INTO rooms (id, owner_id, owner_device_id, room_name, invite_code, invite_code_expires_at, max_members, auto_approve)
       VALUES (@id, @owner_id, @owner_device_id, @room_name, @invite_code, @invite_code_expires_at, @max_members, @auto_approve)`
    ).run({ ...room, auto_approve: room.auto_approve ?? 1 });
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
