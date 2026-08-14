CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  email TEXT UNIQUE,
  phone TEXT UNIQUE,
  password_hash TEXT NOT NULL,
  account_role TEXT NOT NULL CHECK (account_role IN ('controller', 'remote')),
  avatar TEXT,
  storage_quota INTEGER NOT NULL DEFAULT 10737418240, -- 10 GB
  storage_used INTEGER NOT NULL DEFAULT 0,
  is_seed_account INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY, -- device_id (client-generated UID)
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_type INTEGER NOT NULL CHECK (device_type IN (1, 2, 3, 4)),
  device_name TEXT NOT NULL,
  model TEXT,
  os_version TEXT,
  capabilities_json TEXT,
  remote_control_enabled INTEGER NOT NULL DEFAULT 1,
  camera_name TEXT,
  refresh_token TEXT,
  is_online INTEGER NOT NULL DEFAULT 0,
  last_seen TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_devices_user ON devices(user_id);

CREATE TABLE IF NOT EXISTS videos (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL,
  session_id TEXT,
  local_video_uid TEXT NOT NULL,
  camera_name TEXT,
  name TEXT NOT NULL,
  description TEXT,
  object_key TEXT NOT NULL,
  thumbnail_key TEXT,
  duration_ms INTEGER,
  size_bytes INTEGER NOT NULL,
  resolution TEXT,
  fps INTEGER,
  codec TEXT DEFAULT 'h264/aac',
  checksum_sha256 TEXT NOT NULL,
  recorded_at TEXT,
  uploaded_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  deleted_at TEXT,
  downloaded_by_controller INTEGER NOT NULL DEFAULT 0,
  UNIQUE (owner_id, local_video_uid, checksum_sha256)
);

CREATE INDEX IF NOT EXISTS idx_videos_owner ON videos(owner_id);
CREATE INDEX IF NOT EXISTS idx_videos_device ON videos(device_id);

CREATE TABLE IF NOT EXISTS uploads (
  id TEXT PRIMARY KEY, -- upload_id
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL,
  file_name TEXT NOT NULL,
  file_size INTEGER NOT NULL,
  mime_type TEXT NOT NULL,
  checksum_sha256 TEXT NOT NULL,
  chunk_size INTEGER NOT NULL,
  total_chunks INTEGER NOT NULL,
  metadata_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', -- pending | completed | aborted | expired
  tmp_dir TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS upload_chunks (
  upload_id TEXT NOT NULL REFERENCES uploads(id) ON DELETE CASCADE,
  chunk_index INTEGER NOT NULL,
  received_bytes INTEGER NOT NULL,
  checksum TEXT,
  received_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (upload_id, chunk_index)
);
