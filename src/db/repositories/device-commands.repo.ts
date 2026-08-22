import { db } from "../index";

export interface DeviceCommandRow {
  id: string;
  device_id: string;
  room_id: string | null;
  member_id: string | null;
  type: string;
  payload_json: string;
  issued_at: string;
  acked_at: string | null;
}

export const deviceCommandsRepo = {
  insert(command: {
    id: string;
    device_id: string;
    room_id: string | null;
    member_id: string | null;
    type: string;
    payload_json: string;
  }): void {
    db.prepare(
      `INSERT INTO device_commands (id, device_id, room_id, member_id, type, payload_json)
       VALUES (@id, @device_id, @room_id, @member_id, @type, @payload_json)`
    ).run(command);
  },

  findById(id: string): DeviceCommandRow | undefined {
    return db.prepare<[string]>("SELECT * FROM device_commands WHERE id = ?").get(id) as
      | DeviceCommandRow
      | undefined;
  },

  listPendingForDevice(deviceId: string): DeviceCommandRow[] {
    return db
      .prepare<[string]>(
        "SELECT * FROM device_commands WHERE device_id = ? AND acked_at IS NULL ORDER BY issued_at ASC"
      )
      .all(deviceId) as DeviceCommandRow[];
  },

  // A client reports the last command_id it executed. Treat that and every
  // earlier not-yet-acked command for the same device as delivered, so a
  // dropped ack response doesn't leave stale commands piling up.
  ackUpTo(deviceId: string, commandId: string): void {
    const command = this.findById(commandId);
    if (!command || command.device_id !== deviceId) return;
    db.prepare(
      `UPDATE device_commands SET acked_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE device_id = ? AND acked_at IS NULL AND issued_at <= ?`
    ).run(deviceId, command.issued_at);
  },
};
