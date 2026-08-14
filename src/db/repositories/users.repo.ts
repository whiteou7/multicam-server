import { db } from "../index";

export type AccountRole = "controller" | "remote";

export interface UserRow {
  id: string;
  first_name: string;
  last_name: string;
  email: string | null;
  phone: string | null;
  password_hash: string;
  account_role: AccountRole;
  avatar: string | null;
  storage_quota: number;
  storage_used: number;
  is_seed_account: number;
  created_at: string;
}

export const usersRepo = {
  findByEmailOrPhone(identifier: string): UserRow | undefined {
    return db
      .prepare<[string, string]>(
        "SELECT * FROM users WHERE email = ? OR phone = ? LIMIT 1"
      )
      .get(identifier, identifier) as UserRow | undefined;
  },

  findById(id: string): UserRow | undefined {
    return db.prepare<[string]>("SELECT * FROM users WHERE id = ?").get(id) as
      | UserRow
      | undefined;
  },

  insert(user: Omit<UserRow, "created_at" | "storage_used">): void {
    db.prepare(
      `INSERT INTO users (id, first_name, last_name, email, phone, password_hash, account_role, avatar, storage_quota, is_seed_account)
       VALUES (@id, @first_name, @last_name, @email, @phone, @password_hash, @account_role, @avatar, @storage_quota, @is_seed_account)`
    ).run(user);
  },

  updateProfile(id: string, fields: Partial<Pick<UserRow, "first_name" | "last_name" | "avatar">>): void {
    const current = this.findById(id);
    if (!current) return;
    db.prepare(
      `UPDATE users SET first_name = @first_name, last_name = @last_name, avatar = @avatar WHERE id = @id`
    ).run({
      id,
      first_name: fields.first_name ?? current.first_name,
      last_name: fields.last_name ?? current.last_name,
      avatar: fields.avatar ?? current.avatar,
    });
  },

  incrementStorageUsed(id: string, deltaBytes: number): void {
    db.prepare("UPDATE users SET storage_used = storage_used + ? WHERE id = ?").run(
      deltaBytes,
      id
    );
  },

  count(): number {
    const row = db.prepare("SELECT COUNT(*) as c FROM users").get() as { c: number };
    return row.c;
  },
};
