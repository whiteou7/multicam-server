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
  push_token TEXT,
  push_devtype INTEGER,
  session_revoked INTEGER NOT NULL DEFAULT 0,
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

-- Room/session control (spec § 2.8-2.9): a Controller creates a room with an
-- invite code, Remotes join it, and both sides poll sync_device/sync_room
-- instead of using sockets (see README "Known simplifications").
CREATE TABLE IF NOT EXISTS rooms (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  owner_device_id TEXT NOT NULL,
  room_name TEXT,
  invite_code TEXT NOT NULL,
  invite_code_expires_at TEXT NOT NULL,
  max_members INTEGER NOT NULL DEFAULT 8,
  -- 1 = auto-approve join (default), 0 = owner must approve each joiner
  auto_approve INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'open', -- open | closed
  session_id TEXT, -- current active recording_sessions.id, if recording
  revision INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  closed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_rooms_owner ON rooms(owner_id);
CREATE INDEX IF NOT EXISTS idx_rooms_invite_code ON rooms(invite_code);

CREATE TABLE IF NOT EXISTS room_members (
  id TEXT PRIMARY KEY, -- member_id
  room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  camera_name TEXT,
  has_granted_control INTEGER NOT NULL DEFAULT 1,
  is_online INTEGER NOT NULL DEFAULT 1,
  battery_level INTEGER,
  is_charging INTEGER,
  storage_free INTEGER,
  temperature_state TEXT,
  recording_state TEXT NOT NULL DEFAULT 'idle', -- idle|accepted|recording|saved|failed
  elapsed_ms INTEGER,
  upload_state TEXT DEFAULT 'none', -- none|uploading|uploaded|failed
  upload_percent INTEGER,
  error_code TEXT,
  flash_mode TEXT DEFAULT 'off',
  zoom_factor REAL DEFAULT 1.0,
  last_command_id TEXT,
  last_seen TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  -- approved = active in room | pending = awaiting owner approval | denied = rejected
  join_status TEXT NOT NULL DEFAULT 'approved',
  joined_revision INTEGER NOT NULL DEFAULT 0,
  left_revision INTEGER,
  joined_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  left_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_room_members_room ON room_members(room_id);
CREATE INDEX IF NOT EXISTS idx_room_members_device ON room_members(device_id);

-- Delivery queue for room/device commands (start_record, stop_record,
-- camera_config, leave_room, logout). Polled via POST /devices/{id}/sync's
-- pending_commands array instead of pushed over a socket.
CREATE TABLE IF NOT EXISTS device_commands (
  id TEXT PRIMARY KEY, -- command_id
  device_id TEXT NOT NULL,
  room_id TEXT REFERENCES rooms(id) ON DELETE CASCADE,
  member_id TEXT,
  type TEXT NOT NULL, -- start_record|stop_record|camera_config|leave_room|logout
  payload_json TEXT NOT NULL DEFAULT '{}',
  issued_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  acked_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_device_commands_device ON device_commands(device_id, acked_at);

CREATE TABLE IF NOT EXISTS recording_sessions (
  id TEXT PRIMARY KEY, -- session_id
  room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  stopped_at TEXT,
  status TEXT NOT NULL DEFAULT 'recording', -- recording|stopped
  config_json TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_recording_sessions_room ON recording_sessions(room_id);

-- get_verify_code / forgot_password (spec § 2.1). No real email/SMS provider
-- is wired up (see README "Known simplifications") — the code is logged
-- server-side only.
CREATE TABLE IF NOT EXISTS verify_codes (
  id TEXT PRIMARY KEY,
  target TEXT NOT NULL, -- email or phone
  purpose TEXT NOT NULL DEFAULT 'forgot_password',
  code_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_verify_codes_target ON verify_codes(target, created_at);
