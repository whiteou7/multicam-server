import "dotenv/config";

function required(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (value === undefined) {
    throw new Error(`Missing required env var ${name}`);
  }
  return value;
}

export const env = {
  port: Number(process.env.PORT ?? 3000),
  host: process.env.HOST ?? "0.0.0.0",

  jwtSecret: required("JWT_SECRET", "dev-secret-change-me"),
  accessTokenTtlSeconds: Number(process.env.ACCESS_TOKEN_TTL_SECONDS ?? 900), // 15 min
  refreshTokenTtlSeconds: Number(process.env.REFRESH_TOKEN_TTL_SECONDS ?? 2_592_000), // 30 days

  dbPath: process.env.DATABASE_PATH ?? "./data/multicam.sqlite3",

  minio: {
    endPoint: required("MINIO_ENDPOINT", "localhost"),
    port: Number(process.env.MINIO_PORT ?? 9000),
    useSSL: (process.env.MINIO_USE_SSL ?? "false") === "true",
    accessKey: required("MINIO_ACCESS_KEY", "minioadmin"),
    secretKey: required("MINIO_SECRET_KEY", "minioadmin"),
    bucket: process.env.MINIO_BUCKET ?? "multicam-videos",
  },

  upload: {
    maxFileSizeBytes: Number(process.env.MAX_FILE_SIZE_BYTES ?? 1_073_741_824), // 1 GB
    chunkSizeBytes: Number(process.env.CHUNK_SIZE_BYTES ?? 5 * 1024 * 1024), // 5 MB
    tmpDir: process.env.UPLOAD_TMP_DIR ?? "./data/upload-tmp",
    sessionTtlMs: Number(process.env.UPLOAD_SESSION_TTL_MS ?? 6 * 60 * 60 * 1000), // 6h
    downloadUrlTtlSeconds: Number(process.env.DOWNLOAD_URL_TTL_SECONDS ?? 600), // 10 min
  },

  mediasoup: {
    numWorkers: Number(process.env.MEDIASOUP_NUM_WORKERS ?? 1),
    rtcMinPort: Number(process.env.MEDIASOUP_RTC_MIN_PORT ?? 40000),
    rtcMaxPort: Number(process.env.MEDIASOUP_RTC_MAX_PORT ?? 49999),
    // LAN/dev default: mediasoup listens on all interfaces and doesn't rewrite
    // its candidate IP. Set MEDIASOUP_ANNOUNCED_IP to the server's public IP
    // for any deployment where clients aren't on the same network.
    listenIp: process.env.MEDIASOUP_LISTEN_IP ?? "0.0.0.0",
    announcedIp: process.env.MEDIASOUP_ANNOUNCED_IP || null,
  },
};
