import { buildApp } from "./app";
import { env } from "./config/env";
import { seedDefaultAccounts } from "./db/seed";
import { sweepStaleMembers } from "./modules/rooms/rooms.service";

async function main() {
  seedDefaultAccounts();

  const app = await buildApp();
  try {
    await app.listen({ port: env.port, host: env.host });

    // Sweep nền: dọn member phone "xác" (app bị kill/crash/xoá dữ liệu/đổi device_id)
    // để dashboard không thấy thừa thành viên. Chạy mỗi 60s, không giữ process sống.
    const sweepTimer = setInterval(() => {
      try {
        const n = sweepStaleMembers();
        if (n > 0) app.log.info({ closed: n }, "sweep: đã dọn member phone im lặng quá lâu");
      } catch (e) {
        app.log.warn({ err: e }, "sweep stale members failed");
      }
    }, 60_000);
    sweepTimer.unref?.();
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

main();
