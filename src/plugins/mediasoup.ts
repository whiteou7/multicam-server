import fp from "fastify-plugin";
import { FastifyInstance } from "fastify";
import * as mediasoup from "mediasoup";
import { env } from "../config/env";

type Worker = mediasoup.types.Worker;

// Codecs offered by every room's Router. VP8 and H264 cover the practical
// range of mobile encoders; Opus for audio.
export const MEDIA_CODECS: mediasoup.types.RouterRtpCodecCapability[] = [
  { kind: "audio", mimeType: "audio/opus", clockRate: 48000, channels: 2 },
  {
    kind: "video",
    mimeType: "video/VP8",
    clockRate: 90000,
    parameters: { "x-google-start-bitrate": 2500 },
  },
  {
    kind: "video",
    mimeType: "video/H264",
    clockRate: 90000,
    parameters: {
      "packetization-mode": 1,
      "profile-level-id": "42e01f",
      "level-asymmetry-allowed": 1,
      "x-google-start-bitrate": 2500,
    },
  },
];

declare module "fastify" {
  interface FastifyInstance {
    mediasoup: {
      getWorker(): Worker;
    };
  }
}

export default fp(async function mediasoupPlugin(app: FastifyInstance) {
  const workers: Worker[] = [];
  for (let i = 0; i < env.mediasoup.numWorkers; i++) {
    const worker = await mediasoup.createWorker({
      rtcMinPort: env.mediasoup.rtcMinPort,
      rtcMaxPort: env.mediasoup.rtcMaxPort,
    });
    worker.on("died", (error) => {
      app.log.error({ err: error, pid: worker.pid }, "mediasoup worker died, exiting");
      process.exit(1);
    });
    workers.push(worker);
  }
  app.log.info(`mediasoup: started ${workers.length} worker(s)`);

  let nextWorker = 0;
  app.decorate("mediasoup", {
    getWorker(): Worker {
      const worker = workers[nextWorker];
      nextWorker = (nextWorker + 1) % workers.length;
      return worker;
    },
  });

  app.addHook("onClose", async () => {
    for (const worker of workers) worker.close();
  });
});
