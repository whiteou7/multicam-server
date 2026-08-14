# Multi-Cam Recorder Backend — API Docs

*Tiếng Việt: [API.vi.md](API.vi.md)*

Implements the 15/8 milestone from `specs/v3_GiaoDien_TichHop_API_MultiCamRecorder.md`:

1. Login with 4 default accounts (1 Controller + 3 Remote).
2. Chunked video upload from a Remote device into MinIO, with resumability and
   dedup, plus enough of the video/download surface for a Controller to list
   and pull clips back — enough to demo the full record → upload → retrieve loop.

Room/session control, sockets, notifications, and device push tokens are **not**
implemented yet — those land with the 22/8 and 29/8 milestones per the roadmap
in the spec (§ "LỘ TRÌNH LÀM VIỆC").

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

### `POST /devices` 🔒
Explicit device (re-)registration, mirrors spec's `register_device`.
Body: `{ "device_id", "device_type", "device_name", "model?", "os_version?", "capabilities?" }`.

### `GET /devices` 🔒
Lists devices registered under the caller's account (spec's `get_device_list`, scoped to self for now — the admin/`user_id` override from the spec isn't implemented).

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

- No room/session, socket, or notification APIs yet (scheduled for 22/8+).
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
    auth/                  login, refresh, logout
    devices/                register + list devices
    videos/                 library CRUD + chunked upload flow
  plugins/                  jwt, minio fastify plugins
  utils/                    response envelope, error codes, validation, password hashing
```
