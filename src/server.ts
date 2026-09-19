import { buildApp, API_PREFIX } from "./app";
import { env } from "./config/env";
import { seedDefaultAccounts } from "./db/seed";
import { ensureDefaultRoom } from "./modules/rooms/defaultRoom.service";
import { startDiscoveryService } from "./modules/discovery/discovery.service";

async function main() {
  seedDefaultAccounts();

  const app = await buildApp();
  try {
    await app.listen({ port: env.port, host: env.host });
    const defRoom = ensureDefaultRoom();
    app.log.info(
      {
        roomName: env.rooms.defaultRoomName,
        roomId: defRoom?.room_id.slice(0, 8),
        inviteCode: defRoom?.invite_code,
        openForJoin: defRoom != null,
      },
      "default room ready (mở trên LAN, không giới hạn thời gian)"
    );
    if (env.discovery.enabled) {
      startDiscoveryService({ version: "1.0.0", apiPrefix: API_PREFIX, httpPort: env.port });
    }
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

main();
