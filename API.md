# Multi-Cam Recorder Backend — API Docs

*Tiếng Việt: [API.vi.md](API.vi.md)*

Implements the 15/8, 22/8 and 29/8 milestones from
`specs/v3_GiaoDien_TichHop_API_MultiCamRecorder.md`:

1. Login with 4 default accounts (1 Controller + 3 Remote).
2. Chunked video upload from a Remote device into MinIO, with resumability and
   dedup, plus enough of the video/download surface for a Controller to list
   and pull clips back — enough to demo the full record → upload → retrieve loop.
3. Room/invite-code pairing, periodic `sync_device`/`sync_room` polling,
   recording control (start/stop across every Remote in a room), and
   per-member camera control (flash/zoom) — the Controller ↔ Remote loop from
   § 2.8-2.9, delivered entirely over polling (see
   [Known simplifications](#known-simplifications-for-this-milestone)).
4. Remaining device-management and password-recovery endpoints
   (`set_device_config`, `delete_device`, `set_devtoken`,
   `get_verify_code`/`forgot_password`/`change_password`).

User-profile endpoints (`/users/*`) and the notifications module
(`/notifications/*`) are intentionally **not** implemented — out of scope by
request, not part of the spec's own roadmap gap.

## Running it

```bash
docker compose up --build
```

This starts:
- `minio` — object storage, S3 API on `:9000`, web console on `:9001` (login `minioadmin` / `minioadmin` by default — override via `.env`, see `.env.example`).
- `backend` — the Fastify API on `:3000`. On first boot it seeds 4 demo accounts (see below) and creates the `multicam-videos` bucket automatically.

For local dev without Docker:

```bash
npm install
cp .env.example .env   # adjust MINIO_ENDPOINT etc. if MinIO isn't on localhost
npm run dev             # tsx watch, auto-seeds accounts on start
```

Health check: `GET /health` → `{"code":1000,"message":"OK","data":{"status":"up"}}`.

## Base URL

Matches spec § 1.3:

```
http://<host>:3000/it4788/api/v1
```

## Response envelope & auth

Every response is `{ code, message, data }` (spec § 1.6). `code: 1000` means
success; see [Error codes](#error-codes) for the rest.

Authenticated routes take `Authorization: Bearer <access_token>`. The access
token JWT carries the account role in the `acc` claim (`controller` |
`remote`), per spec § 1.3 — routes that are role-restricted check this claim
server-side (e.g. `get_download_url` is Controller-only).

- Access token TTL: 15 min (`ACCESS_TOKEN_TTL_SECONDS`)
- Refresh token TTL: 30 days (`REFRESH_TOKEN_TTL_SECONDS`)
- `POST /auth/refresh` exchanges a valid refresh token for a new pair. If it
  fails, the client should drop the session and return to the login screen
  (spec § 1.3).

## Demo accounts (seeded on startup)

| Role | Phone | Password |
|---|---|---|
| controller | `0900000001` | `Controller@123` |
| remote | `0900000002` | `Remote@123` |
| remote | `0900000003` | `Remote@123` |
| remote | `0900000004` | `Remote@123` |

Re-running the seed (`npm run seed`) is idempotent — existing accounts are left alone.

---

## Endpoints

### `POST /auth/login`

Body:
```json
{
  "phone": "0900000002",
  "password": "Remote@123",
  "device_id": "device-uuid-or-uid",
  "device_type": 1,
  "device_name": "Pixel 8"
}
```
`device_type`: `1` Android, `2` iOS, `4` Web (`3` reserved for a future desktop app).

Response `data`:
```json
{
  "user": { "id": "...", "first_name": "...", "last_name": "...", "email": "...", "phone": "...", "avatar": null },
  "account_role": "remote",
  "access_token": "...",
  "refresh_token": "...",
  "expires_in": 900,
  "device": { "id": "device-uuid-or-uid", "remote_control_enabled": 1 }
}
```
Login also upserts the device row (equivalent to spec's `register_device` for
the common case of "device registers itself on login").

### `POST /auth/refresh`
Body: `{ "refresh_token": "..." }` → same shape as login's `access_token` / `refresh_token` / `expires_in`.

### `POST /auth/logout` 🔒
Revokes the refresh token bound to the calling device.

### `POST /auth/verify-code` — `get_verify_code`
Body: `{ "email"?, "phone"? }` (one of the two).
- Throttled to one call per target every 120s (`1010 Action has been done previously`).
- Generates a 6-digit code (5 min TTL) and logs it server-side — **no email/SMS
  provider is wired up in this milestone**, so delivery is simulated.
- Response: `{ expires_in, masked_target }` (e.g. `a***@gmail.com` / `090*****02`).

### `POST /auth/password/forgot` — `forgot_password`
Body: `{ "email"?, "phone"?, "code_verify", "new_password" }`. Verifies the
code from `get_verify_code`, updates the password, and — as a safety
measure — revokes every device's refresh token for that account.

### `PUT /auth/password` 🔒 — `change_password`
Body: `{ "old_password", "new_password" }`. Revokes every *other* device's
refresh token; the calling device keeps its session.

### `POST /devices` 🔒
Explicit device (re-)registration, mirrors spec's `register_device`.
Body: `{ "device_id", "device_type", "device_name", "model?", "os_version?", "capabilities?" }`.

### `GET /devices` 🔒
Lists devices registered under the caller's account (spec's `get_device_list`, scoped to self for now — the admin/`user_id` override from the spec isn't implemented).

### `PUT /devices/{device_id}` 🔒 — `set_device_config`
Body: `{ "remote_control_enabled"?, "camera_name"? }`. Rejects turning
`remote_control_enabled` off with `1012 Limited access` while the device is
an active room member — leave the room first.

### `DELETE /devices/{device_id}` 🔒 — `delete_device`
Revokes a device's session (own devices only): clears its refresh token and
sets `session_revoked = 1`, which that device picks up on its next
`sync_device`/`refresh` call and must treat as a forced logout.

### `PUT /devices/{device_id}/push-token` 🔒 — `set_devtoken`
Body: `{ "devtype" (1=android, 2=ios), "devtoken" }`. Web devices
(`device_type = 4`) get `1012 Limited access` — matches the spec's example
for that code.

### `POST /devices/{device_id}/sync` 🔒 — `sync_device`
The periodic (3-5s) heartbeat from spec § 1.5/2.3 — pushes hardware/recording
telemetry and pulls any commands queued for this device. This is also how
`start_record`/`stop_record`/`camera_config`/`leave_room` commands are
delivered; there is no push socket in this milestone (see
[Known simplifications](#known-simplifications-for-this-milestone)).

Body (all optional — only fields present are applied):
```json
{
  "battery_level": 80,
  "is_charging": 0,
  "storage_free": 1073741824,
  "temperature_state": "normal",
  "recording_state": "recording",
  "elapsed_ms": 5000,
  "upload_state": "none",
  "upload_percent": 0,
  "error_code": null,
  "last_command_id": "<uuid of the last command this device executed>"
}
```
Response:
```json
{
  "server_time": "...",
  "next_sync_in": 3,
  "room_status": { "in_room": 1, "room_id": "...", "session_id": "..." },
  "pending_commands": [
    { "command_id": "...", "type": "start_record", "payload": { ... }, "issued_at": "..." }
  ],
  "session_revoked": 0
}
```
`next_sync_in` is `3` while the device's room is recording, `5` otherwise.
Reporting `last_command_id` acks that command (and anything older, in case a
previous ack response was dropped) so it stops being re-delivered.

---

### Chunked video upload (Remote uploads a clip → MinIO)

Mirrors spec § 2.6.

#### `POST /videos/uploads` 🔒 — `init_upload`
```json
{
  "file_name": "clip1.mp4",
  "file_size": 12582912,
  "mime_type": "video/mp4",
  "checksum_sha256": "<sha256 of the whole file>",
  "metadata": {
    "local_video_uid": "0f3b9c7e-...",
    "device_id": "device-uuid-or-uid",
    "camera_name": "CamTrai",
    "session_id": "standalone",
    "recorded_at": "2026-08-14T10:00:00Z",
    "duration_ms": 15000,
    "resolution": "1920x1080",
    "fps": 30
  }
}
```
- Rejects files over 1 GB (`1006 File size is too big`) or non-`video/mp4` mime types (`1004`).
- If `(local_video_uid, checksum_sha256)` was already uploaded by this account, returns `already_uploaded: 1` and the existing `video_id` immediately — no new session is opened, matching the "don't re-send 1 GB" rule in the spec.
- Otherwise returns `upload_id`, `chunk_size` (default 5 MiB, `CHUNK_SIZE_BYTES`), `total_chunks`, and `expires_at` (default 6h, `UPLOAD_SESSION_TTL_MS`).

#### `PUT /videos/uploads/{upload_id}/chunks/{index}` 🔒 — `upload_chunk`
- `Content-Type: application/octet-stream`, raw chunk bytes as the body.
- Optional `chunk-checksum` header (sha256 of that chunk) — if present, mismatches are rejected with `1007 Upload file failed`.
- Chunks can be sent in any order and re-sent idempotently.
- Response: `{ chunk_index, received, next_expected_index }` (`next_expected_index: null` once everything has arrived).

#### `GET /videos/uploads/{upload_id}` 🔒 — `get_upload_status`
Returns `{ upload_id, status, received_chunks: [...], missing_chunks: [...], expires_at }` — poll this after a dropped connection to resume only the missing chunks.

#### `POST /videos/uploads/{upload_id}/complete` 🔒 — `complete_upload`
- Fails with `1011 Could not publish this post` if any chunk is still missing.
- Assembles the chunks in order, re-verifies `checksum_sha256` against the whole file (fails with `1007` on mismatch), uploads the result to MinIO at `videos/{user_id}/{device_id}/{session_id}/{video_id}.mp4`, records the `Video`, and cleans up the temp chunk directory.
- Response: `{ video_id, local_video_uid, url, thumbnail_url, duration_ms, size, created_at }`. `url` is a 1-hour presigned MinIO GET URL. `thumbnail_url` is always `null` for now — thumbnail generation needs `ffmpeg` and isn't implemented in this milestone.

#### `DELETE /videos/uploads/{upload_id}` 🔒 — `abort_upload`
Deletes any received chunks and marks the session aborted.

---

### Video library

#### `POST /videos/check-uploaded` 🔒 — `check_uploaded`
Body: `{ "items": [{ "local_video_uid", "checksum_sha256", "file_size" }, ...] }` (max 100).
Returns per-item `{ local_video_uid, uploaded, video_id, uploaded_at }` — used by a Remote device's Library screen to label local clips without a client-side DB.

#### `GET /videos` 🔒 — `get_list_videos`
Query: `index`, `count` (max 100), `session_id?`, `device_id?`, `sort` (`created_at_desc`|`created_at_asc`).
- Remote accounts see only clips they uploaded.
- Controller accounts currently see **every** uploaded clip system-wide — room-scoped filtering ("only clips from Remotes that joined my room") is deferred until the room/session APIs (22/8 milestone) exist to define that scope.

#### `GET /videos/{video_id}` 🔒 — `get_video`
Returns clip detail plus a fresh 1-hour presigned playback `url`.

#### `PUT /videos/{video_id}` 🔒 — `update_video`
Body: `{ "name"?, "description"? }`. Owner-only.

#### `DELETE /videos/{video_id}` 🔒 — `delete_video`
Soft-deletes the server-side record only (does not touch the file still sitting in the Remote device's local clip folder). Owner-only.

#### `POST /videos/bulk-delete` 🔒 — `delete_videos_bulk`
Body: `{ "video_ids": [...] }` (max 50) → `{ deleted: [...], failed: [{ id, reason }] }`.

#### `GET /videos/{video_id}/download` 🔒 — `get_download_url` — **Controller only**
Returns a presigned MinIO GET URL (`DOWNLOAD_URL_TTL_SECONDS`, default 10 min), and marks `downloaded_by_controller = 1`. Remote accounts get `1009 Not access`.

---

### Room & recording control (spec § 2.8-2.9)

A Controller creates a room and shares its 6-character invite code; Remotes
join and grant control; the Controller starts/stops recording and adjusts
camera settings across the whole room. All of it is driven by
`sync_device`/`sync_room` polling — see
[Known simplifications](#known-simplifications-for-this-milestone) for why
there's no push socket or live-preview stream in this milestone. Every route
below except `POST /rooms` and `POST /rooms/join` requires the caller to be
the room's owner (Controller) — enforced by ownership, not just role, so it
also implicitly rejects other Controllers' rooms.

#### `POST /rooms` 🔒 — `create_room` — **Controller only**
Body: `{ "room_name"?, "max_members"? }` (default 8). Requires the caller's
device to have `remote_control_enabled = 1` (`1012` if not). If the
Controller already has an open room, returns that room instead of creating a
new one.
```json
{ "room_id": "...", "invite_code": "SKY8G4", "expires_at": "...", "owner_device_id": "...", "created_at": "..." }
```

#### `POST /rooms/join` 🔒 — `join_room`
Body: `{ "invite_code", "device_id", "camera_name", "grant_control": true }`
(`device_id` must match the authenticated device; `grant_control` must be
`true` — a Remote can always revoke it afterwards via
`set_member_permission`). `1010` if the device is already in a room, `1008`
if the room is full, `9992` if the code is wrong/expired.

#### `GET /rooms/{room_id}/members` 🔒 — `get_room_members`
Full member list — call once when the grid screen opens; use `sync_room` for
updates afterwards.

#### `GET /rooms/{room_id}/sync` 🔒 — `sync_room`
Query: `since?` (the `revision` from the previous call). The Controller's
periodic (3-5s) poll — one call replaces the `device_status`/`state_changed`/
`device_error`/`upload_progress` socket events from the previous design.
```json
{
  "server_time": "...", "revision": 5, "next_sync_in": 3,
  "room": { "status": "open", "session_id": "...", "started_at": "..." },
  "members": [ { "member_id": "...", "camera_name": "...", "is_online": 1, "has_granted_control": 1, "battery_level": 79, "recording_state": "recording", "elapsed_ms": 5000, "upload_state": "none", "...": "..." } ],
  "joined": [ /* members with joined_revision > since */ ],
  "left": [ /* member_id of members with left_revision > since */ ]
}
```

#### `POST /rooms/{room_id}/invite-code` 🔒 — `refresh_invite_code`
Regenerates the code (10 min TTL) and invalidates the old one.

#### `DELETE /rooms/{room_id}/members/{member_id}` 🔒 — `kick_member`
Removes a member; queues a `leave_room` command so the device exits room mode
on its next `sync_device`.

#### `DELETE /rooms/{room_id}` 🔒 — `close_room`
If a recording session is active, queues `stop_record` (then `leave_room`)
for every member before closing. Response: `{ closed_at, session_stopped }`.

#### `POST /rooms/{room_id}/leave` 🔒 — `leave_room`
Remote calls this on itself (must be the member's own device).

#### `PUT /rooms/{room_id}/members/{member_id}/permission` 🔒 — `set_member_permission`
Body: `{ "grant_control": 0 | 1 }`. Only the Remote device that owns the
membership may call this — a Controller can never force-grant itself control.

#### `POST /rooms/{room_id}/preview-token` 🔒 — `get_preview_token`
Body: `{ "quality": "low"|"medium", "protocol": "hls"|"webrtc" }`. Returns
`{ preview_token, expires_in, streams: [{ member_id, stream_url }] }` —
**`stream_url` is always `null`**: there's no WebRTC/HLS media server in this
codebase, only post-hoc chunked upload to MinIO. The contract shape is real
so a grid UI can already bind `member_id` → tile.

#### `POST /rooms/{room_id}/recording/start` 🔒 — `start_recording`
Body: `{ "target": "all" | ["member_id", ...], "config"?: { "resolution"?, "fps"?, "max_duration"? }, "client_command_id" }`.
Queues a `start_record` command (delivered via `sync_device`) to every
targeted member that's online and has granted control. `1010` if the room is
already recording; `1011` if no target is eligible.
```json
{ "session_id": "...", "started_at": "...", "command_id": "cmd-1", "targets": ["member-1"], "rejected": [{ "member_id": "member-2", "reason": "offline" }] }
```

#### `POST /rooms/{room_id}/recording/stop` 🔒 — `stop_recording`
Body: `{ "target": "all" | ["member_id", ...], "client_command_id" }`. Video
is **not** auto-uploaded — it stays in the Remote's local clip folder until
the user sends it. Results reflect the queued command only
(`status: "stop_queued"`, no duration/size yet) — each member's actual
completion shows up asynchronously via `sync_room`/`get_recording_session`
once that Remote's next `sync_device` reports `recording_state: saved`.

#### `PUT /rooms/{room_id}/members/{member_id}/camera` 🔒 — `set_camera_config`
Body: `{ "flash_mode": "off"|"on"|"auto"|"torch", "zoom_factor": 0.5-10.0, "client_command_id" }`.
Queues a `camera_config` command; the member row is updated optimistically
(the spec's suggestion to wait for `sync_room` confirmation is a client-side
concern).

#### `GET /rooms/{room_id}/members/{member_id}/camera` 🔒 — `get_camera_config`
Returns `{ flash_mode, zoom_factor, zoom_range: { min, max }, has_flash }`.
`zoom_range`/`has_flash` come from the device's registered `capabilities`
when present, else default to `{0.5, 10.0}` / `true`.

---

### Recording sessions

#### `GET /recording-sessions/{session_id}` 🔒 — `get_recording_session`
Viewable by the room's owner or by any account that has (or had) a
membership in that room. Joins each member against `videos` by
`(device_id, session_id)` — which is how a Remote's `init_upload` metadata
(carrying the `session_id` from the `start_record` command payload) ties
back to the session:
```json
{
  "session_id": "...", "room_id": "...", "started_at": "...", "stopped_at": "...", "status": "stopped",
  "members": [ { "member_id": "...", "camera_name": "...", "state": "recording", "duration": 5000, "video_id": "...", "uploaded": 1 } ]
}
```

---

### `GET /app/version` — `check_new_version`
Query: `platform`, `current_version` (both accepted, currently unused).
Static response for now — this backend doesn't track per-platform client
releases: `{ latest_version, is_force_update: 0, release_note, store_url }`.

---

## Error codes

Implemented per spec § 1.6 (`src/utils/codes.ts`):

| code | meaning |
|---|---|
| 1000 | OK |
| 1001 | Can not connect to DB / object storage |
| 1002 | Missing required parameter |
| 1003 | Wrong parameter type |
| 1004 | Invalid parameter value |
| 1005 | Unknown error |
| 1006 | File too big (>1 GB video, or role-specific limits) |
| 1007 | Upload failed (chunk/whole-file checksum mismatch, etc.) |
| 1008 | Max items exceeded (e.g. >100 `check_uploaded` items, >50 bulk-delete) |
| 1009 | Not access (wrong role / not the owner) |
| 1010 | Already done previously |
| 1011 | Could not complete (e.g. `complete_upload` with missing chunks) |
| 1012 | Limited access (policy restriction) |
| 9992 | Not existed (also used for unmatched routes) |
| 9993 | Code verify incorrect |
| 9994 | No data / end of list |
| 9995 | User not validated (bad credentials / inactive / locked) |
| 9996 | User already exists |
| 9997 | Method invalid |
| 9998 | Token invalid (also the default for missing/expired auth) |
| 9999 | Exception error (uncaught server error) |

## Known simplifications for this milestone

- **No push socket.** The spec explicitly allows this — commands
  (`start_record`/`stop_record`/`camera_config`/`leave_room`/`logout`) are
  delivered entirely through `pending_commands` in `sync_device` polling, and
  the app is fully functional without a socket per the spec's own note in § 1.5.
- **No live preview streaming.** `get_preview_token` returns the contracted
  shape but every `stream_url` is `null` — there's no WebRTC/HLS media server
  in this codebase, only post-hoc chunked upload to MinIO.
- **No real email/SMS provider.** `get_verify_code` generates and stores a
  code and logs it server-side; delivery is out of scope.
- **`create_share_link`/`revoke_share_link` are not implemented.** They're
  named in spec § 1.3's role-check list and § 1.6's error table, but no
  endpoint/method/params row exists anywhere in the spec to implement against.
- **User-profile (`/users/*`) and notifications (`/notifications/*`) are not
  implemented** — out of scope by request for this pass, not a spec gap.
- `stop_recording`'s `results` reflect the queued command only
  (`status: "stop_queued"`) — final per-member state (duration, `video_id`)
  is only knowable once that Remote's next `sync_device` reports
  `recording_state: saved`; poll `sync_room`/`get_recording_session` for it.
- No thumbnail generation on upload (`thumbnail_url` is always `null`).
- Controller's `get_list_videos` isn't room-scoped yet; it sees all clips.
- `register_device`'s `capabilities` are stored as-is but not validated or used.
- Storage is SQLite (file-based, single instance) — fine for local demo, not for multi-instance deployment.

## Project layout

```
src/
  app.ts, server.ts        Fastify app wiring, entrypoint
  config/env.ts             Environment config
  db/                       better-sqlite3 client, schema.sql, seed.ts, repositories/
  middleware/authenticate.ts JWT auth + role guard
  modules/
    auth/                  login, refresh, logout, password recovery
    devices/                register/list/config/push-token + sync_device
    videos/                 library CRUD + chunked upload flow
    rooms/                  invite codes, sync_room, recording + camera control
    recording-sessions/     get_recording_session
    app/                    check_new_version
  plugins/                  jwt, minio fastify plugins
  utils/                    response envelope, error codes, validation, password hashing
```
