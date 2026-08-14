import { db } from "../index";

export type UploadStatus = "pending" | "completed" | "aborted" | "expired";

export interface UploadRow {
  id: string;
  owner_id: string;
  device_id: string;
  file_name: string;
  file_size: number;
  mime_type: string;
  checksum_sha256: string;
  chunk_size: number;
  total_chunks: number;
  metadata_json: string;
  status: UploadStatus;
  tmp_dir: string;
  expires_at: string;
  created_at: string;
}

export interface UploadChunkRow {
  upload_id: string;
  chunk_index: number;
  received_bytes: number;
  checksum: string | null;
  received_at: string;
}

export const uploadsRepo = {
  insert(upload: Omit<UploadRow, "created_at">): void {
    db.prepare(
      `INSERT INTO uploads (id, owner_id, device_id, file_name, file_size, mime_type, checksum_sha256,
                             chunk_size, total_chunks, metadata_json, status, tmp_dir, expires_at)
       VALUES (@id, @owner_id, @device_id, @file_name, @file_size, @mime_type, @checksum_sha256,
               @chunk_size, @total_chunks, @metadata_json, @status, @tmp_dir, @expires_at)`
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

  recordChunk(uploadId: string, chunkIndex: number, receivedBytes: number, checksum?: string): void {
    db.prepare(
      `INSERT INTO upload_chunks (upload_id, chunk_index, received_bytes, checksum)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(upload_id, chunk_index) DO UPDATE SET
         received_bytes = excluded.received_bytes,
         checksum = excluded.checksum,
         received_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`
    ).run(uploadId, chunkIndex, receivedBytes, checksum ?? null);
  },

  listChunks(uploadId: string): UploadChunkRow[] {
    return db
      .prepare<[string]>("SELECT * FROM upload_chunks WHERE upload_id = ? ORDER BY chunk_index ASC")
      .all(uploadId) as UploadChunkRow[];
  },

  receivedChunkIndexes(uploadId: string): number[] {
    const rows = db
      .prepare<[string]>("SELECT chunk_index FROM upload_chunks WHERE upload_id = ? ORDER BY chunk_index ASC")
      .all(uploadId) as { chunk_index: number }[];
    return rows.map((r) => r.chunk_index);
  },

  deleteChunks(uploadId: string): void {
    db.prepare("DELETE FROM upload_chunks WHERE upload_id = ?").run(uploadId);
  },
};
