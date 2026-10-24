import { db } from "../index";

export type UploadStatus = "pending" | "completed" | "aborted" | "expired" | "failed";

export interface UploadRow {
  id: string;
  owner_id: string;
  device_id: string;
  file_name: string;
  file_size: number;
  mime_type: string;
  checksum_sha256: string;
  object_key: string;
  metadata_json: string;
  status: UploadStatus;
  expires_at: string;
  created_at: string;
}

export const uploadsRepo = {
  insert(upload: Omit<UploadRow, "created_at">): void {
    db.prepare(
      `INSERT INTO uploads (id, owner_id, device_id, file_name, file_size, mime_type, checksum_sha256,
                             object_key, metadata_json, status, expires_at)
       VALUES (@id, @owner_id, @device_id, @file_name, @file_size, @mime_type, @checksum_sha256,
               @object_key, @metadata_json, @status, @expires_at)`
    ).run(upload);
  },

  findById(id: string): UploadRow | undefined {
    return db.prepare<[string]>("SELECT * FROM uploads WHERE id = ?").get(id) as
      | UploadRow
      | undefined;
  },

  setStatus(id: string, status: UploadStatus): void {
    db.prepare("UPDATE uploads SET status = ? WHERE id = ?").run(status, id);
  },
};
