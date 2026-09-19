import { randomUUID } from "node:crypto";
import { db } from "./index";
import { usersRepo } from "./repositories/users.repo";
import { devicesRepo } from "./repositories/devices.repo";
import { hashPassword } from "../utils/password";
import { env } from "../config/env";

// Default demo accounts for the 15/8 milestone: 1 Controller (issuer-provided) + 3 Remote.
const SEED_ACCOUNTS: Array<{
  first_name: string;
  last_name: string;
  phone: string;
  email: string;
  password: string;
  account_role: "controller" | "remote";
}> = [
  {
    first_name: "Multicam",
    last_name: "Controller",
    phone: "0900000001",
    email: "controller@multicam.local",
    password: "Controller@123",
    account_role: "controller",
  },
  {
    first_name: "Remote",
    last_name: "One",
    phone: "0900000002",
    email: "remote1@multicam.local",
    password: "Remote@123",
    account_role: "remote",
  },
  {
    first_name: "Remote",
    last_name: "Two",
    phone: "0900000003",
    email: "remote2@multicam.local",
    password: "Remote@123",
    account_role: "remote",
  },
  {
    first_name: "Remote",
    last_name: "Three",
    phone: "0900000004",
    email: "remote3@multicam.local",
    password: "Remote@123",
    account_role: "remote",
  },
];

export function seedDefaultAccounts(): void {
  const insertIfMissing = db.transaction(() => {
    for (const account of SEED_ACCOUNTS) {
      const existing = usersRepo.findByEmailOrPhone(account.phone);
      if (existing) continue;
      usersRepo.insert({
        id: randomUUID(),
        first_name: account.first_name,
        last_name: account.last_name,
        email: account.email,
        phone: account.phone,
        password_hash: hashPassword(account.password),
        account_role: account.account_role,
        avatar: null,
        storage_quota: 10 * 1024 * 1024 * 1024,
        is_seed_account: 1,
      });
    }
  });
  insertIfMissing();
  ensureDefaultRoomOwner();
}

/** Device id cố định của owner "phòng chung" — phòng trỏ owner_device_id vào đây. */
const DEFAULT_ROOM_OWNER_DEVICE_ID = "default-room-device";

/**
 * Owner hệ thống nắm giữ phòng chung (tự tạo khi server khởi động). Tài khoản này
 * không dành cho thao tác hằng ngày — chỉ để phòng có owner hợp lệ.
 */
function ensureDefaultRoomOwner(): void {
  if (!env.rooms.defaultRoomEnabled) return;
  const { defaultOwnerEmail, defaultOwnerPassword } = env.rooms;
  let owner = usersRepo.findByEmailOrPhone(defaultOwnerEmail);
  if (!owner) {
    usersRepo.insert({
      id: randomUUID(),
      first_name: "Default",
      last_name: "Room",
      email: defaultOwnerEmail,
      phone: null,
      password_hash: hashPassword(defaultOwnerPassword),
      account_role: "controller",
      avatar: null,
      storage_quota: 10 * 1024 * 1024 * 1024,
      is_seed_account: 1,
    });
    owner = usersRepo.findByEmailOrPhone(defaultOwnerEmail)!;
  }
  devicesRepo.upsert({
    id: DEFAULT_ROOM_OWNER_DEVICE_ID,
    user_id: owner.id,
    device_type: 1,
    device_name: "Server",
  });
  devicesRepo.setConfig(DEFAULT_ROOM_OWNER_DEVICE_ID, { remote_control_enabled: 1 });
}

if (require.main === module) {
  seedDefaultAccounts();
  // eslint-disable-next-line no-console
  console.log("Seed complete. Demo accounts:");
  for (const account of SEED_ACCOUNTS) {
    console.log(`  [${account.account_role}] phone=${account.phone} password=${account.password}`);
  }
}
