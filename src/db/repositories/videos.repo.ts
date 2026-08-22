import { db } from "../index";

export interface VideoRow {
  id: string;
  owner_id: string;
  device_id: string;
  session_id: string | null;
  local_video_uid: string;
  camera_name: string | null;
  name: string;
  description: string | null;
  object_key: string;
  thumbnail_key: string | null;
  duration_ms: number | null;
  size_bytes: number;
  resolution: string | null;
  fps: number | null;
  codec: string | null;
  checksum_sha256: string;
  recorded_at: string | null;
  uploaded_at: string;
  deleted_at: string | null;
  downloaded_by_controller: number;
}

export const videosRepo = {
  insert(video: Omit<VideoRow, "uploaded_at" | "deleted_at" | "downloaded_by_controller">): void {
    db.prepare(
      `INSERT INTO videos (id, owner_id, device_id, session_id, local_video_uid, camera_name, name, description,
                            object_key, thumbnail_key, duration_ms, size_bytes, resolution, fps, codec,
                            checksum_sha256, recorded_at)
       VALUES (@id, @owner_id, @device_id, @session_id, @local_video_uid, @camera_name, @name, @description,
               @object_key, @thumbnail_key, @duration_ms, @size_bytes, @resolution, @fps, @codec,
               @checksum_sha256, @recorded_at)`
    ).run(video);
  },

  findById(id: string): VideoRow | undefined {
    return db
      .prepare<[string]>("SELECT * FROM videos WHERE id = ? AND deleted_at IS NULL")
      .get(id) as VideoRow | undefined;
  },

  findByLocalUidAndChecksum(
    ownerId: string,
    localVideoUid: string,
    checksum: string
  ): VideoRow | undefined {
    return db
      .prepare<[string, string, string]>(
        `SELECT * FROM videos WHERE owner_id = ? AND local_video_uid = ? AND checksum_sha256 = ? AND deleted_at IS NULL`
      )
      .get(ownerId, localVideoUid, checksum) as VideoRow | undefined;
  },

  listForUser(
    ownerId: string,
    opts: { index: number; count: number; sessionId?: string; deviceId?: string; sortAsc?: boolean }
  ): VideoRow[] {
    const order = opts.sortAsc ? "ASC" : "DESC";
    const clauses = ["owner_id = ?", "deleted_at IS NULL"];
    const params: (string | number)[] = [ownerId];
    if (opts.sessionId) {
      clauses.push("session_id = ?");
      params.push(opts.sessionId);
    }
    if (opts.deviceId) {
      clauses.push("device_id = ?");
      params.push(opts.deviceId);
    }
    params.push(opts.count, opts.index);
    return db
      .prepare(
        `SELECT * FROM videos WHERE ${clauses.join(" AND ")} ORDER BY uploaded_at ${order} LIMIT ? OFFSET ?`
      )
      .all(...params) as VideoRow[];
  },

  listAll(opts: { index: number; count: number; sessionId?: string; deviceId?: string; sortAsc?: boolean }): VideoRow[] {
    const order = opts.sortAsc ? "ASC" : "DESC";
    const clauses = ["deleted_at IS NULL"];
    const params: (string | number)[] = [];
    if (opts.sessionId) {
      clauses.push("session_id = ?");
      params.push(opts.sessionId);
    }
    if (opts.deviceId) {
      clauses.push("device_id = ?");
      params.push(opts.deviceId);
    }
    params.push(opts.count, opts.index);
    return db
      .prepare(
        `SELECT * FROM videos WHERE ${clauses.join(" AND ")} ORDER BY uploaded_at ${order} LIMIT ? OFFSET ?`
      )
      .all(...params) as VideoRow[];
  },

  markDownloadedByController(id: string): void {
    db.prepare("UPDATE videos SET downloaded_by_controller = 1 WHERE id = ?").run(id);
  },

  softDelete(id: string): void {
    db.prepare("UPDATE videos SET deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?").run(id);
  },

  findByDeviceAndSession(deviceId: string, sessionId: string): VideoRow | undefined {
    return db
      .prepare<[string, string]>(
        "SELECT * FROM videos WHERE device_id = ? AND session_id = ? AND deleted_at IS NULL LIMIT 1"
      )
      .get(deviceId, sessionId) as VideoRow | undefined;
  },

  updateNameDescription(id: string, name?: string, description?: string): void {
    const current = this.findById(id);
    if (!current) return;
    db.prepare("UPDATE videos SET name = ?, description = ? WHERE id = ?").run(
      name ?? current.name,
      description ?? current.description,
      id
    );
  },
};
