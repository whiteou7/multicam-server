import { db } from "../index";

export interface VerifyCodeRow {
  id: string;
  target: string;
  purpose: string;
  code_hash: string;
  expires_at: string;
  consumed_at: string | null;
  created_at: string;
}

export const verifyCodesRepo = {
  insert(row: { id: string; target: string; purpose: string; code_hash: string; expires_at: string }): void {
    db.prepare(
      `INSERT INTO verify_codes (id, target, purpose, code_hash, expires_at)
       VALUES (@id, @target, @purpose, @code_hash, @expires_at)`
    ).run(row);
  },

  findLatestByTarget(target: string, purpose: string): VerifyCodeRow | undefined {
    return db
      .prepare<[string, string]>(
        "SELECT * FROM verify_codes WHERE target = ? AND purpose = ? ORDER BY created_at DESC LIMIT 1"
      )
      .get(target, purpose) as VerifyCodeRow | undefined;
  },

  consume(id: string): void {
    db.prepare("UPDATE verify_codes SET consumed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?").run(
      id
    );
  },
};
