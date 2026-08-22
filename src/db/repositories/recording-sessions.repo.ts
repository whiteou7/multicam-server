import { db } from "../index";

export interface RecordingSessionRow {
  id: string;
  room_id: string;
  started_at: string;
  stopped_at: string | null;
  status: "recording" | "stopped";
  config_json: string;
}

export const recordingSessionsRepo = {
  insert(session: { id: string; room_id: string; config_json: string }): void {
    db.prepare(
      `INSERT INTO recording_sessions (id, room_id, config_json) VALUES (@id, @room_id, @config_json)`
    ).run(session);
  },

  findById(id: string): RecordingSessionRow | undefined {
    return db.prepare<[string]>("SELECT * FROM recording_sessions WHERE id = ?").get(id) as
      | RecordingSessionRow
      | undefined;
  },

  findActiveByRoom(roomId: string): RecordingSessionRow | undefined {
    return db
      .prepare<[string]>(
        "SELECT * FROM recording_sessions WHERE room_id = ? AND status = 'recording' LIMIT 1"
      )
      .get(roomId) as RecordingSessionRow | undefined;
  },

  setStopped(id: string): void {
    db.prepare(
      "UPDATE recording_sessions SET status = 'stopped', stopped_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?"
    ).run(id);
  },
};
