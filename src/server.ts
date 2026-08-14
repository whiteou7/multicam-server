import { buildApp } from "./app";
import { env } from "./config/env";
import { seedDefaultAccounts } from "./db/seed";

async function main() {
  seedDefaultAccounts();

  const app = await buildApp();
  try {
    await app.listen({ port: env.port, host: env.host });
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

main();
