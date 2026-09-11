import { db } from "../index";

export interface RoomMemberRow {
  id: string;
  room_id: string;
  device_id: string;
  user_id: string;
  camera_name: string | null;
  has_granted_control: number;
  is_online: number;
  battery_level: number | null;
  is_charging: number | null;
  storage_free: number | null;
  temperature_state: string | null;
  recording_state: string;
  elapsed_ms: number | null;
  upload_state: string | null;
  upload_percent: number | null;
  error_code: string | null;
  flash_mode: string | null;
  zoom_factor: number | null;
  last_command_id: string | null;
  last_seen: string;
  join_status: "approved" | "pending" | "denied";
  joined_revision: number;
  left_revision: number | null;
  joined_at: string;
  left_at: string | null;
}

export const roomMembersRepo = {
  insert(member: {
    id: string;
    room_id: string;
    device_id: string;
    user_id: string;
    camera_name: string | null;
    joined_revision: number;
    join_status?: "approved" | "pending";
  }): void {
    db.prepare(
      `INSERT INTO room_members (id, room_id, device_id, user_id, camera_name, joined_revision, join_status)
       VALUES (@id, @room_id, @device_id, @user_id, @camera_name, @joined_revision, @join_status)`
    ).run({ ...member, join_status: member.join_status ?? "approved" });
  },

  findById(memberId: string): RoomMemberRow | undefined {
    return db.prepare<[string]>("SELECT * FROM room_members WHERE id = ?").get(memberId) as
      | RoomMemberRow
      | undefined;
  },

  findActiveByRoomAndDevice(roomId: string, deviceId: string): RoomMemberRow | undefined {
    return db
      .prepare<[string, string]>(
        "SELECT * FROM room_members WHERE room_id = ? AND device_id = ? AND left_at IS NULL"
      )
      .get(roomId, deviceId) as RoomMemberRow | undefined;
  },

  findActiveByDevice(deviceId: string): RoomMemberRow | undefined {
    return db
      .prepare<[string]>("SELECT * FROM room_members WHERE device_id = ? AND left_at IS NULL LIMIT 1")
      .get(deviceId) as RoomMemberRow | undefined;
  },

  findAnyByRoomAndUser(roomId: string, userId: string): RoomMemberRow | undefined {
    return db
      .prepare<[string, string]>("SELECT * FROM room_members WHERE room_id = ? AND user_id = ? LIMIT 1")
      .get(roomId, userId) as RoomMemberRow | undefined;
  },

  listAllByRoom(roomId: string): RoomMemberRow[] {
    return db
      .prepare<[string]>("SELECT * FROM room_members WHERE room_id = ? ORDER BY joined_at ASC")
      .all(roomId) as RoomMemberRow[];
  },

  listActiveByRoom(roomId: string): RoomMemberRow[] {
    return db
      .prepare<[string]>(
        "SELECT * FROM room_members WHERE room_id = ? AND left_at IS NULL AND join_status = 'approved' ORDER BY joined_at ASC"
      )
      .all(roomId) as RoomMemberRow[];
  },

  listPendingByRoom(roomId: string): RoomMemberRow[] {
    return db
      .prepare<[string]>(
        "SELECT * FROM room_members WHERE room_id = ? AND left_at IS NULL AND join_status = 'pending' ORDER BY joined_at ASC"
      )
      .all(roomId) as RoomMemberRow[];
  },

  setJoinStatus(memberId: string, joinStatus: "approved" | "pending" | "denied"): void {
    db.prepare("UPDATE room_members SET join_status = ? WHERE id = ?").run(joinStatus, memberId);
  },

  listJoinedSince(roomId: string, sinceRevision: number): RoomMemberRow[] {
    return db
      .prepare<[string, number]>(
        "SELECT * FROM room_members WHERE room_id = ? AND left_at IS NULL AND joined_revision > ?"
      )
      .all(roomId, sinceRevision) as RoomMemberRow[];
  },

  listLeftSince(roomId: string, sinceRevision: number): RoomMemberRow[] {
    return db
      .prepare<[string, number]>(
        "SELECT * FROM room_members WHERE room_id = ? AND left_at IS NOT NULL AND left_revision > ?"
      )
      .all(roomId, sinceRevision) as RoomMemberRow[];
  },

  updateTelemetry(
    memberId: string,
    fields: Partial<
      Pick<
        RoomMemberRow,
        | "battery_level"
        | "is_charging"
        | "storage_free"
        | "temperature_state"
        | "recording_state"
        | "elapsed_ms"
        | "upload_state"
        | "upload_percent"
        | "error_code"
        | "last_command_id"
      >
    >
  ): void {
    const current = this.findById(memberId);
    if (!current) return;
    db.prepare(
      `UPDATE room_members SET
        battery_level = @battery_level,
        is_charging = @is_charging,
        storage_free = @storage_free,
        temperature_state = @temperature_state,
        recording_state = @recording_state,
        elapsed_ms = @elapsed_ms,
        upload_state = @upload_state,
        upload_percent = @upload_percent,
        error_code = @error_code,
        last_command_id = @last_command_id,
        is_online = 1,
        last_seen = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE id = @id`
    ).run({
      id: memberId,
      battery_level: fields.battery_level ?? current.battery_level,
      is_charging: fields.is_charging ?? current.is_charging,
      storage_free: fields.storage_free ?? current.storage_free,
      temperature_state: fields.temperature_state ?? current.temperature_state,
      recording_state: fields.recording_state ?? current.recording_state,
      elapsed_ms: fields.elapsed_ms ?? current.elapsed_ms,
      upload_state: fields.upload_state ?? current.upload_state,
      upload_percent: fields.upload_percent ?? current.upload_percent,
      error_code: fields.error_code ?? current.error_code,
      last_command_id: fields.last_command_id ?? current.last_command_id,
    });
  },

  setControl(memberId: string, hasGrantedControl: 0 | 1): void {
    db.prepare("UPDATE room_members SET has_granted_control = ? WHERE id = ?").run(
      hasGrantedControl,
      memberId
    );
  },

  setCamera(memberId: string, flashMode: string, zoomFactor: number): void {
    db.prepare("UPDATE room_members SET flash_mode = ?, zoom_factor = ? WHERE id = ?").run(
      flashMode,
      zoomFactor,
      memberId
    );
  },

  setLeft(memberId: string, leftRevision: number): void {
    db.prepare(
      `UPDATE room_members SET left_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), left_revision = ?,
        has_granted_control = 0, is_online = 0 WHERE id = ?`
    ).run(leftRevision, memberId);
  },
};
