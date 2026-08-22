import { FastifyInstance } from "fastify";
import { ok } from "../../utils/response";

// check_new_version — spec § 2.1/2.7. Static for now: this backend doesn't
// track per-platform client releases, so every platform gets the same
// hardcoded "current" answer (never forces an update).
const LATEST_VERSION = "1.0.0";

export default async function appRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: { platform?: string; current_version?: string } }>(
    "/app/version",
    async () => {
      return ok({
        latest_version: LATEST_VERSION,
        is_force_update: 0,
        release_note: "",
        store_url: null,
      });
    }
  );
}
