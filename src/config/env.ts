import "dotenv/config";

function required(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (value === undefined) {
    throw new Error(`Missing required env var ${name}`);
  }
  return value;
}

function num(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (Number.isNaN(value)) {
    throw new Error(`Env var ${name} must be a number, got "${process.env[name]}"`);
  }
  return value;
}

export const env = {
  port: num("PORT", 3000),
  host: process.env.HOST ?? "0.0.0.0",
  // Comma-separated allowed origins; empty = reflect any origin (previous behavior).
  corsOrigins: (process.env.CORS_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean),

  jwtSecret: required("JWT_SECRET", "dev-secret-change-me"),
  accessTokenTtlSeconds: num("ACCESS_TOKEN_TTL_SECONDS", 900), // 15 min
  refreshTokenTtlSeconds: num("REFRESH_TOKEN_TTL_SECONDS", 2_592_000), // 30 days

  dbPath: process.env.DATABASE_PATH ?? "./data/multicam.sqlite3",

  minio: {
    endPoint: required("MINIO_ENDPOINT", "localhost"),
    port: num("MINIO_PORT", 9000),
    useSSL: (process.env.MINIO_USE_SSL ?? "false") === "true",
    accessKey: required("MINIO_ACCESS_KEY", "minioadmin"),
    secretKey: required("MINIO_SECRET_KEY", "minioadmin"),
    bucket: process.env.MINIO_BUCKET ?? "multicam-videos",
    // Host clients use for presigned URLs (e.g. s3.example.com behind TLS).
    // Unset = presign against the internal endpoint above (LAN/dev).
    publicEndPoint: process.env.MINIO_PUBLIC_ENDPOINT || null,
    publicPort: process.env.MINIO_PUBLIC_PORT ? num("MINIO_PUBLIC_PORT", 0) : undefined,
    publicUseSSL: (process.env.MINIO_PUBLIC_USE_SSL ?? "false") === "true",
  },

  upload: {
    maxFileSizeBytes: num("MAX_FILE_SIZE_BYTES", 1_073_741_824), // 1 GB
    // Also the lifetime of the presigned PUT URL (S3 caps presign at 7 days).
    sessionTtlMs: num("UPLOAD_SESSION_TTL_MS", 6 * 60 * 60 * 1000), // 6h
    downloadUrlTtlSeconds: num("DOWNLOAD_URL_TTL_SECONDS", 600), // 10 min
  },

  mediasoup: {
    numWorkers: num("MEDIASOUP_NUM_WORKERS", 1),
    rtcMinPort: num("MEDIASOUP_RTC_MIN_PORT", 40000),
    rtcMaxPort: num("MEDIASOUP_RTC_MAX_PORT", 49999),
    // LAN/dev default: mediasoup listens on all interfaces and doesn't rewrite
    // its candidate IP. Set MEDIASOUP_ANNOUNCED_IP to the server's public IP
    // for any deployment where clients aren't on the same network.
    listenIp: process.env.MEDIASOUP_LISTEN_IP ?? "0.0.0.0",
    announcedIp: process.env.MEDIASOUP_ANNOUNCED_IP || null,
  },
};
