import { db } from "../index";

export interface DeviceRow {
  id: string;
  user_id: string;
  device_type: number;
  device_name: string;
  model: string | null;
  os_version: string | null;
  capabilities_json: string | null;
  remote_control_enabled: number;
  camera_name: string | null;
  refresh_token: string | null;
  is_online: number;
  last_seen: string | null;
  push_token: string | null;
  push_devtype: number | null;
  session_revoked: number;
  created_at: string;
  updated_at: string;
}

export const devicesRepo = {
  findById(id: string): DeviceRow | undefined {
    return db.prepare<[string]>("SELECT * FROM devices WHERE id = ?").get(id) as
      | DeviceRow
      | undefined;
  },

  upsert(device: {
    id: string;
    user_id: string;
    device_type: number;
    device_name: string;
    model?: string | null;
    os_version?: string | null;
    capabilities_json?: string | null;
  }): void {
    db.prepare(
      `INSERT INTO devices (id, user_id, device_type, device_name, model, os_version, capabilities_json, camera_name, is_online, last_seen)
       VALUES (@id, @user_id, @device_type, @device_name, @model, @os_version, @capabilities_json, @device_name, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
       ON CONFLICT(id) DO UPDATE SET
         user_id = excluded.user_id,
         device_type = excluded.device_type,
         device_name = excluded.device_name,
         model = COALESCE(excluded.model, devices.model),
         os_version = COALESCE(excluded.os_version, devices.os_version),
         capabilities_json = COALESCE(excluded.capabilities_json, devices.capabilities_json),
         is_online = 1,
         session_revoked = 0,
         last_seen = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`
    ).run({
      id: device.id,
      user_id: device.user_id,
      device_type: device.device_type,
      device_name: device.device_name,
      model: device.model ?? null,
      os_version: device.os_version ?? null,
      capabilities_json: device.capabilities_json ?? null,
    });
  },

  setRefreshToken(id: string, refreshToken: string | null): void {
    db.prepare("UPDATE devices SET refresh_token = ? WHERE id = ?").run(refreshToken, id);
  },

  listByUser(userId: string): DeviceRow[] {
    return db
      .prepare<[string]>("SELECT * FROM devices WHERE user_id = ? ORDER BY created_at DESC")
      .all(userId) as DeviceRow[];
  },

  setConfig(id: string, fields: { remote_control_enabled?: number; camera_name?: string }): void {
    const current = this.findById(id);
    if (!current) return;
    db.prepare(
      `UPDATE devices SET remote_control_enabled = @remote_control_enabled, camera_name = @camera_name,
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = @id`
    ).run({
      id,
      remote_control_enabled: fields.remote_control_enabled ?? current.remote_control_enabled,
      camera_name: fields.camera_name ?? current.camera_name,
    });
  },

  setPushToken(id: string, devtype: number, devtoken: string): void {
    db.prepare("UPDATE devices SET push_devtype = ?, push_token = ? WHERE id = ?").run(
      devtype,
      devtoken,
      id
    );
  },

  setSessionRevoked(id: string, revoked: 0 | 1): void {
    db.prepare("UPDATE devices SET session_revoked = ? WHERE id = ?").run(revoked, id);
  },

  revokeSession(id: string): void {
    db.prepare("UPDATE devices SET refresh_token = NULL, session_revoked = 1 WHERE id = ?").run(id);
  },

  // Used by change_password/forgot_password to sign every other session out.
  revokeAllForUser(userId: string, exceptDeviceId?: string): void {
    db.prepare(
      "UPDATE devices SET refresh_token = NULL, session_revoked = 1 WHERE user_id = ? AND id != ?"
    ).run(userId, exceptDeviceId ?? "");
  },
};
