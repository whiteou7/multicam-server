# Multi-Cam Recorder Backend — Tài liệu API

*English: [API.md](API.md)*

Bản này hiện thực các mốc 15/8, 22/8 và 29/8 trong
`specs/v3_GiaoDien_TichHop_API_MultiCamRecorder.md`:

1. Đăng nhập với 4 tài khoản mặc định (1 Controller + 3 Remote).
2. Upload video dạng chunk từ máy Remote lên MinIO, hỗ trợ tiếp tục upload dở
   dang và chống trùng, kèm đủ phần thư viện/tải xuống để máy Controller liệt
   kê và tải clip về — đủ để demo trọn luồng quay → upload → lấy về.
3. Ghép phòng qua mã mời, đồng bộ định kỳ `sync_device`/`sync_room`, điều
   khiển quay (bắt đầu/dừng đồng thời toàn bộ máy Remote trong phòng), và
   điều khiển camera từng máy (flash/zoom) — đúng luồng Controller ↔ Remote
   ở mục 2.8-2.9, thực hiện hoàn toàn qua polling (xem
   [Những điểm đơn giản hóa](#những-điểm-đơn-giản-hóa-trong-mốc-này)).
4. Các API quản lý thiết bị và khôi phục mật khẩu còn lại
   (`set_device_config`, `delete_device`, `set_devtoken`,
   `get_verify_code`/`forgot_password`/`change_password`).

Các API hồ sơ người dùng (`/users/*`) và module thông báo (`/notifications/*`)
**chủ động không cài đặt** trong đợt này theo yêu cầu — không phải phần còn
thiếu của lộ trình trong đặc tả.

## Cách chạy

```bash
docker compose up --build
```

Lệnh trên khởi động:
- `minio` — kho lưu trữ đối tượng, API kiểu S3 ở cổng `:9000`, giao diện web quản trị ở cổng `:9001` (đăng nhập mặc định `minioadmin` / `minioadmin` — có thể đổi qua `.env`, xem `.env.example`).
- `backend` — API Fastify ở cổng `:3000`. Lần chạy đầu tự động tạo 4 tài khoản demo (xem bên dưới) và tự tạo bucket `multicam-videos`.

Chạy dev cục bộ không dùng Docker:

```bash
npm install
cp .env.example .env   # chỉnh MINIO_ENDPOINT... nếu MinIO không chạy ở localhost
npm run dev             # tsx watch, tự seed tài khoản khi khởi động
```

Kiểm tra sống: `GET /health` → `{"code":1000,"message":"OK","data":{"status":"up"}}`.

## Base URL

Theo đúng mục 1.3 của tài liệu đặc tả:

```
http://<host>:3000/it4788/api/v1
```

## Khuôn dạng phản hồi & xác thực

Mọi phản hồi đều có dạng `{ code, message, data }` (mục 1.6 của đặc tả).
`code: 1000` nghĩa là thành công; các mã còn lại xem ở [Bảng mã lỗi](#bảng-mã-lỗi).

Các API cần đăng nhập nhận header `Authorization: Bearer <access_token>`.
Access token (JWT) mang vai trò tài khoản trong claim `acc` (`controller` |
`remote`) theo mục 1.3 — những API giới hạn theo vai trò sẽ kiểm tra claim
này ở phía server (ví dụ `get_download_url` chỉ dành cho Controller).

- Thời hạn access token: 15 phút (`ACCESS_TOKEN_TTL_SECONDS`)
- Thời hạn refresh token: 30 ngày (`REFRESH_TOKEN_TTL_SECONDS`)
- `POST /auth/refresh` đổi refresh token còn hạn lấy cặp token mới. Nếu thất
  bại, client nên xóa phiên và quay về màn Đăng nhập (mục 1.3 đặc tả).

## Tài khoản demo (tự tạo khi khởi động)

| Vai trò | Số điện thoại | Mật khẩu |
|---|---|---|
| controller | `0900000001` | `Controller@123` |
| remote | `0900000002` | `Remote@123` |
| remote | `0900000003` | `Remote@123` |
| remote | `0900000004` | `Remote@123` |

Chạy lại lệnh seed (`npm run seed`) là an toàn (idempotent) — tài khoản đã có sẽ được giữ nguyên.

---

## Danh sách API

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
`device_type`: `1` Android, `2` iOS, `4` Web (`3` để dành cho ứng dụng máy tính sau này).

`data` trả về:
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
Đăng nhập cũng đồng thời tạo/cập nhật (upsert) bản ghi thiết bị — tương đương
với `register_device` trong đặc tả cho trường hợp phổ biến "thiết bị tự đăng
ký ngay khi đăng nhập".

### `POST /auth/refresh`
Body: `{ "refresh_token": "..." }` → trả về cùng cấu trúc `access_token` / `refresh_token` / `expires_in` như khi đăng nhập.

### `POST /auth/logout` 🔒
Thu hồi refresh token gắn với thiết bị đang gọi.

### `POST /auth/verify-code` — `get_verify_code`
Body: `{ "email"?, "phone"? }` (một trong hai).
- Giới hạn 1 lần gọi mỗi 120 giây cho cùng một target (`1010 Action has been done previously`).
- Sinh mã 6 số (hạn 5 phút) và ghi log ở server — **chưa tích hợp nhà cung cấp
  email/SMS thật** trong mốc này nên việc gửi chỉ là giả lập.
- Phản hồi: `{ expires_in, masked_target }` (ví dụ `a***@gmail.com` / `090*****02`).

### `POST /auth/password/forgot` — `forgot_password`
Body: `{ "email"?, "phone"?, "code_verify", "new_password" }`. Đối chiếu mã đã
lấy từ `get_verify_code`, đổi mật khẩu, và để an toàn thì thu hồi refresh
token của toàn bộ thiết bị đang đăng nhập vào tài khoản đó.

### `PUT /auth/password` 🔒 — `change_password`
Body: `{ "old_password", "new_password" }`. Thu hồi refresh token của mọi
thiết bị *khác*; thiết bị đang gọi vẫn giữ nguyên phiên.

### `POST /devices` 🔒
Đăng ký (hoặc cập nhật) thiết bị một cách tường minh, tương đương `register_device` trong đặc tả.
Body: `{ "device_id", "device_type", "device_name", "model?", "os_version?", "capabilities?" }`.

### `GET /devices` 🔒
Liệt kê các thiết bị đã đăng ký dưới tài khoản đang gọi (tương đương `get_device_list`, hiện chỉ giới hạn trong phạm vi chính tài khoản đó — chưa hỗ trợ tham số `user_id` dành cho admin như trong đặc tả).

### `PUT /devices/{device_id}` 🔒 — `set_device_config`
Body: `{ "remote_control_enabled"?, "camera_name"? }`. Từ chối tắt
`remote_control_enabled` với mã `1012 Limited access` khi thiết bị đang là
thành viên một phòng — phải rời phòng trước.

### `DELETE /devices/{device_id}` 🔒 — `delete_device`
Thu hồi phiên của một thiết bị (chỉ thiết bị của chính mình): xóa refresh
token và đặt `session_revoked = 1`, thiết bị đó nhận được cờ này ở lần
`sync_device`/`refresh` kế tiếp và phải tự đăng xuất.

### `PUT /devices/{device_id}/push-token` 🔒 — `set_devtoken`
Body: `{ "devtype" (1=android, 2=ios), "devtoken" }`. Thiết bị Web
(`device_type = 4`) nhận lỗi `1012 Limited access` — đúng ví dụ của mã này
trong đặc tả.

### `POST /devices/{device_id}/sync` 🔒 — `sync_device`
API đồng bộ định kỳ (3-5 giây) theo mục 1.5/2.3 của đặc tả — đẩy trạng thái
phần cứng/quay lên và nhận về các lệnh đang chờ. Đây cũng là đường duy nhất
để nhận lệnh `start_record`/`stop_record`/`camera_config`/`leave_room` —
mốc này chưa có socket đẩy lệnh (xem
[Những điểm đơn giản hóa](#những-điểm-đơn-giản-hóa-trong-mốc-này)).

Body (mọi trường đều tùy chọn — chỉ trường nào có mới được áp dụng):
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
  "last_command_id": "<uuid lệnh cuối thiết bị đã thực hiện>"
}
```
Phản hồi:
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
`next_sync_in` là `3` khi phòng của thiết bị đang quay, ngược lại là `5`. Gửi
`last_command_id` sẽ đánh dấu đã nhận lệnh đó (và mọi lệnh cũ hơn, phòng khi
phản hồi ack trước đó bị rớt mạng) để không bị gửi lại nữa.

---

### Upload video theo chunk (máy Remote gửi clip → MinIO)

Tương ứng mục 2.6 của đặc tả.

#### `POST /videos/uploads` 🔒 — `init_upload`
```json
{
  "file_name": "clip1.mp4",
  "file_size": 12582912,
  "mime_type": "video/mp4",
  "checksum_sha256": "<sha256 của toàn bộ file>",
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
- Từ chối file vượt quá 1 GB (`1006 File size is too big`) hoặc không phải mime type `video/mp4` (`1004`).
- Nếu cặp `(local_video_uid, checksum_sha256)` đã được chính tài khoản này upload trước đó, trả về ngay `already_uploaded: 1` kèm `video_id` cũ — không mở phiên upload mới, đúng theo quy tắc "không truyền lại 1 GB dữ liệu" trong đặc tả.
- Ngược lại trả về `upload_id`, `chunk_size` (mặc định 5 MiB, `CHUNK_SIZE_BYTES`), `total_chunks`, và `expires_at` (mặc định 6 giờ, `UPLOAD_SESSION_TTL_MS`).

#### `PUT /videos/uploads/{upload_id}/chunks/{index}` 🔒 — `upload_chunk`
- `Content-Type: application/octet-stream`, body là dữ liệu nhị phân thô của mảnh.
- Header `chunk-checksum` (sha256 của riêng mảnh đó) là tùy chọn — nếu có mà sai thì bị từ chối với mã `1007 Upload file failed`.
- Các mảnh có thể gửi theo bất kỳ thứ tự nào và gửi lại nhiều lần vẫn an toàn (idempotent).
- Phản hồi: `{ chunk_index, received, next_expected_index }` (`next_expected_index: null` khi đã nhận đủ toàn bộ).

#### `GET /videos/uploads/{upload_id}` 🔒 — `get_upload_status`
Trả về `{ upload_id, status, received_chunks: [...], missing_chunks: [...], expires_at }` — gọi API này sau khi mất kết nối để biết cần gửi lại đúng những mảnh nào.

#### `POST /videos/uploads/{upload_id}/complete` 🔒 — `complete_upload`
- Báo lỗi `1011 Could not publish this post` nếu còn thiếu mảnh nào.
- Ghép các mảnh theo đúng thứ tự, đối chiếu lại `checksum_sha256` với toàn bộ file (lỗi `1007` nếu sai), tải kết quả lên MinIO tại đường dẫn `videos/{user_id}/{device_id}/{session_id}/{video_id}.mp4`, ghi bản ghi `Video`, rồi dọn thư mục chunk tạm.
- Phản hồi: `{ video_id, local_video_uid, url, thumbnail_url, duration_ms, size, created_at }`. `url` là link phát trực tiếp có chữ ký của MinIO, hạn 1 giờ. `thumbnail_url` hiện luôn là `null` — việc sinh thumbnail cần `ffmpeg` và chưa được cài đặt trong mốc này.

#### `DELETE /videos/uploads/{upload_id}` 🔒 — `abort_upload`
Xóa các mảnh đã nhận và đánh dấu phiên upload là đã hủy.

---

### Thư viện video

#### `POST /videos/check-uploaded` 🔒 — `check_uploaded`
Body: `{ "items": [{ "local_video_uid", "checksum_sha256", "file_size" }, ...] }` (tối đa 100 phần tử).
Trả về theo từng item `{ local_video_uid, uploaded, video_id, uploaded_at }` — dùng ở màn Thư viện của máy Remote để gắn nhãn clip đã gửi hay chưa mà không cần cơ sở dữ liệu ở client.

#### `GET /videos` 🔒 — `get_list_videos`
Query: `index`, `count` (tối đa 100), `session_id?`, `device_id?`, `sort` (`created_at_desc`|`created_at_asc`).
- Tài khoản Remote chỉ thấy clip do chính mình upload.
- Tài khoản Controller hiện thấy **toàn bộ** clip trong hệ thống — việc lọc theo phòng ("chỉ clip của các máy Remote đã vào phòng của mình") sẽ được bổ sung khi có API phòng/phiên quay (mốc 22/8) để xác định phạm vi đó.

#### `GET /videos/{video_id}` 🔒 — `get_video`
Trả về chi tiết clip kèm `url` phát lại có chữ ký, hạn 1 giờ, sinh mới mỗi lần gọi.

#### `PUT /videos/{video_id}` 🔒 — `update_video`
Body: `{ "name"?, "description"? }`. Chỉ chủ sở hữu clip mới gọi được.

#### `DELETE /videos/{video_id}` 🔒 — `delete_video`
Chỉ xóa mềm bản ghi trên server (không đụng tới file vẫn còn nằm trong thư mục clip của máy Remote). Chỉ chủ sở hữu clip mới gọi được.

#### `POST /videos/bulk-delete` 🔒 — `delete_videos_bulk`
Body: `{ "video_ids": [...] }` (tối đa 50) → `{ deleted: [...], failed: [{ id, reason }] }`.

#### `GET /videos/{video_id}/download` 🔒 — `get_download_url` — **Chỉ dành cho Controller**
Trả về link tải có chữ ký của MinIO (`DOWNLOAD_URL_TTL_SECONDS`, mặc định 10 phút), đồng thời đánh dấu `downloaded_by_controller = 1`. Tài khoản Remote gọi API này sẽ nhận lỗi `1009 Not access`.

---

### Điều khiển phòng & phiên quay (đặc tả mục 2.8-2.9)

Controller tạo phòng và chia sẻ mã mời 6 ký tự; máy Remote nhập mã và cấp
quyền điều khiển; Controller bắt đầu/dừng quay và chỉnh camera cho toàn
phòng. Toàn bộ dựa trên polling `sync_device`/`sync_room` — xem
[Những điểm đơn giản hóa](#những-điểm-đơn-giản-hóa-trong-mốc-này) để biết vì
sao mốc này chưa có socket đẩy lệnh hay luồng xem trực tiếp. Mọi API bên
dưới, trừ `POST /rooms` và `POST /rooms/join`, đều yêu cầu người gọi là chủ
phòng (Controller) — kiểm tra theo quyền sở hữu chứ không chỉ theo vai trò,
nên cũng tự động chặn luôn phòng của Controller khác.

#### `POST /rooms` 🔒 — `create_room` — **Chỉ dành cho Controller**
Body: `{ "room_name"?, "max_members"? }` (mặc định 8). Yêu cầu thiết bị đang
gọi phải có `remote_control_enabled = 1` (`1012` nếu chưa bật). Nếu Controller
đã có phòng đang mở thì trả về phòng đó thay vì tạo phòng mới.
```json
{ "room_id": "...", "invite_code": "SKY8G4", "expires_at": "...", "owner_device_id": "...", "created_at": "..." }
```

#### `POST /rooms/join` 🔒 — `join_room`
Body: `{ "invite_code", "device_id", "camera_name", "grant_control": true }`
(`device_id` phải trùng thiết bị đang xác thực; `grant_control` phải bằng
`true` — Remote luôn có thể thu hồi lại sau qua `set_member_permission`).
`1010` nếu thiết bị đã ở phòng khác, `1008` nếu phòng đã đầy, `9992` nếu mã
sai hoặc hết hạn.

#### `GET /rooms/{room_id}/members` 🔒 — `get_room_members`
Danh sách đầy đủ thành viên — gọi một lần khi mở màn lưới; các lần cập nhật
sau dùng `sync_room`.

#### `GET /rooms/{room_id}/sync` 🔒 — `sync_room`
Query: `since?` (giá trị `revision` của lần gọi trước). API đồng bộ định kỳ
(3-5 giây) của Controller — một lời gọi thay thế các socket event
`device_status`/`state_changed`/`device_error`/`upload_progress` của thiết
kế cũ.
```json
{
  "server_time": "...", "revision": 5, "next_sync_in": 3,
  "room": { "status": "open", "session_id": "...", "started_at": "..." },
  "members": [ { "member_id": "...", "camera_name": "...", "is_online": 1, "has_granted_control": 1, "battery_level": 79, "recording_state": "recording", "elapsed_ms": 5000, "upload_state": "none", "...": "..." } ],
  "joined": [ /* thành viên có joined_revision > since */ ],
  "left": [ /* member_id của thành viên có left_revision > since */ ]
}
```

#### `POST /rooms/{room_id}/invite-code` 🔒 — `refresh_invite_code`
Sinh mã mới (hạn 10 phút) và vô hiệu hóa mã cũ.

#### `DELETE /rooms/{room_id}/members/{member_id}` 🔒 — `kick_member`
Loại một thành viên; xếp lệnh `leave_room` để thiết bị đó thoát chế độ phòng
ở lần `sync_device` kế tiếp.

#### `DELETE /rooms/{room_id}` 🔒 — `close_room`
Nếu đang có phiên quay, xếp lệnh `stop_record` (rồi `leave_room`) cho mọi
thành viên trước khi đóng phòng. Phản hồi: `{ closed_at, session_stopped }`.

#### `POST /rooms/{room_id}/leave` 🔒 — `leave_room`
Remote tự gọi cho chính mình (phải là thiết bị của thành viên đó).

#### `PUT /rooms/{room_id}/members/{member_id}/permission` 🔒 — `set_member_permission`
Body: `{ "grant_control": 0 | 1 }`. Chỉ thiết bị Remote sở hữu thành viên đó
mới gọi được — Controller không thể tự ép cấp quyền cho mình.

#### `POST /rooms/{room_id}/preview-token` 🔒 — `get_preview_token`
Body: `{ "quality": "low"|"medium", "protocol": "hls"|"webrtc" }`. Trả về
`{ preview_token, expires_in, streams: [{ member_id, stream_url }] }` —
**`stream_url` luôn là `null`**: mã nguồn này chưa có media server
WebRTC/HLS, chỉ có luồng upload theo chunk sau khi quay xong. Cấu trúc dữ
liệu là thật để giao diện lưới có thể gắn sẵn `member_id` → ô hiển thị.

#### `POST /rooms/{room_id}/recording/start` 🔒 — `start_recording`
Body: `{ "target": "all" | ["member_id", ...], "config"?: { "resolution"?, "fps"?, "max_duration"? }, "client_command_id" }`.
Xếp lệnh `start_record` (giao qua `sync_device`) cho mọi thành viên đang
online và đã cấp quyền. `1010` nếu phòng đang quay rồi; `1011` nếu không có
máy nào đủ điều kiện.
```json
{ "session_id": "...", "started_at": "...", "command_id": "cmd-1", "targets": ["member-1"], "rejected": [{ "member_id": "member-2", "reason": "offline" }] }
```

#### `POST /rooms/{room_id}/recording/stop` 🔒 — `stop_recording`
Body: `{ "target": "all" | ["member_id", ...], "client_command_id" }`. Video
**không** tự động upload — vẫn nằm trong thư mục clip của máy Remote cho tới
khi người dùng chủ động gửi. Kết quả trả về chỉ phản ánh lệnh vừa xếp hàng
(`status: "stop_queued"`, chưa có duration/size) — trạng thái hoàn tất thật
sự của từng máy chỉ có sau khi lần `sync_device` kế tiếp của máy đó báo
`recording_state: saved`; theo dõi qua `sync_room`/`get_recording_session`.

#### `PUT /rooms/{room_id}/members/{member_id}/camera` 🔒 — `set_camera_config`
Body: `{ "flash_mode": "off"|"on"|"auto"|"torch", "zoom_factor": 0.5-10.0, "client_command_id" }`.
Xếp lệnh `camera_config`; bản ghi thành viên được cập nhật ngay theo hướng
lạc quan (việc chờ `sync_room` xác nhận là do phía client tự quyết định theo
gợi ý của đặc tả).

#### `GET /rooms/{room_id}/members/{member_id}/camera` 🔒 — `get_camera_config`
Trả về `{ flash_mode, zoom_factor, zoom_range: { min, max }, has_flash }`.
`zoom_range`/`has_flash` lấy từ `capabilities` đã đăng ký của thiết bị nếu
có, không thì mặc định `{0.5, 10.0}` / `true`.

---

### Phiên quay

#### `GET /recording-sessions/{session_id}` 🔒 — `get_recording_session`
Xem được bởi chủ phòng hoặc bất kỳ tài khoản nào đang/đã từng là thành viên
phòng đó. Ghép từng thành viên với `videos` theo `(device_id, session_id)` —
đây là cách khối metadata của `init_upload` phía Remote (mang theo
`session_id` từ payload lệnh `start_record`) nối lại được với phiên quay:
```json
{
  "session_id": "...", "room_id": "...", "started_at": "...", "stopped_at": "...", "status": "stopped",
  "members": [ { "member_id": "...", "camera_name": "...", "state": "recording", "duration": 5000, "video_id": "...", "uploaded": 1 } ]
}
```

---

### `GET /app/version` — `check_new_version`
Query: `platform`, `current_version` (được nhận nhưng chưa dùng đến). Hiện
trả về giá trị tĩnh vì backend chưa theo dõi phiên bản client theo từng nền
tảng: `{ latest_version, is_force_update: 0, release_note, store_url }`.

---

## Bảng mã lỗi

Cài đặt đúng theo mục 1.6 của đặc tả (`src/utils/codes.ts`):

| Mã | Ý nghĩa |
|---|---|
| 1000 | Thành công |
| 1001 | Không kết nối được CSDL / kho lưu trữ đối tượng |
| 1002 | Thiếu tham số bắt buộc |
| 1003 | Sai kiểu tham số |
| 1004 | Sai giá trị tham số |
| 1005 | Lỗi không xác định |
| 1006 | File quá lớn (video vượt 1 GB, hoặc giới hạn riêng theo vai trò) |
| 1007 | Upload thất bại (sai checksum của mảnh/toàn file, v.v.) |
| 1008 | Vượt giới hạn số lượng (ví dụ >100 phần tử `check_uploaded`, >50 khi xóa hàng loạt) |
| 1009 | Không có quyền (sai vai trò / không phải chủ sở hữu) |
| 1010 | Hành động đã thực hiện trước đó |
| 1011 | Không thể hoàn tất (ví dụ `complete_upload` khi còn thiếu mảnh) |
| 1012 | Bị giới hạn theo chính sách |
| 9992 | Không tồn tại (cũng dùng cho route không khớp) |
| 9993 | Mã xác thực sai |
| 9994 | Hết dữ liệu / cuộn hết danh sách |
| 9995 | Tài khoản không hợp lệ (sai thông tin đăng nhập / chưa kích hoạt / đã khóa) |
| 9996 | Tài khoản đã tồn tại |
| 9997 | Sai phương thức |
| 9998 | Token không hợp lệ (cũng là mã mặc định khi thiếu/hết hạn xác thực) |
| 9999 | Lỗi ngoại lệ (lỗi không lường trước ở server) |

## Những điểm đơn giản hóa trong mốc này

- **Chưa có socket đẩy lệnh.** Đặc tả cho phép điều này — mọi lệnh
  (`start_record`/`stop_record`/`camera_config`/`leave_room`/`logout`) được
  giao hoàn toàn qua `pending_commands` khi polling `sync_device`, và ứng
  dụng vẫn chạy đủ chức năng nếu không có socket, đúng như ghi chú ở mục 1.5
  của đặc tả.
- **Chưa có luồng xem trực tiếp thật.** `get_preview_token` trả đúng cấu
  trúc dữ liệu nhưng `stream_url` luôn là `null` — mã nguồn này chưa có
  media server WebRTC/HLS, chỉ có luồng upload theo chunk sau khi quay xong.
- **Chưa tích hợp nhà cung cấp email/SMS thật.** `get_verify_code` sinh và
  lưu mã, rồi ghi log ở server; việc gửi thật nằm ngoài phạm vi mốc này.
- **Chưa cài đặt `create_share_link`/`revoke_share_link`.** Hai API này được
  nhắc tên trong danh sách kiểm tra vai trò ở mục 1.3 và bảng mã lỗi ở mục
  1.6 của đặc tả, nhưng không có dòng đặc tả endpoint/method/tham số nào cho
  chúng để hiện thực theo.
- **Chưa cài đặt hồ sơ người dùng (`/users/*`) và thông báo
  (`/notifications/*`)** — chủ động bỏ qua trong đợt này theo yêu cầu, không
  phải phần thiếu của đặc tả.
- `results` trả về từ `stop_recording` chỉ phản ánh lệnh vừa xếp hàng
  (`status: "stop_queued"`) — trạng thái cuối cùng của từng máy (duration,
  `video_id`) chỉ biết được sau khi lần `sync_device` kế tiếp của máy đó báo
  `recording_state: saved`; theo dõi qua `sync_room`/`get_recording_session`.
- Chưa sinh thumbnail khi upload (`thumbnail_url` luôn là `null`).
- `get_list_videos` của Controller chưa lọc theo phòng; hiện thấy tất cả clip.
- `capabilities` trong `register_device` được lưu nguyên trạng nhưng chưa được kiểm tra hay sử dụng.
- Lưu trữ dùng SQLite (dạng file, một instance duy nhất) — phù hợp để demo cục bộ, chưa phù hợp khi triển khai nhiều instance song song.

## Cấu trúc project

```
src/
  app.ts, server.ts        Khởi tạo Fastify app, điểm vào chương trình
  config/env.ts             Cấu hình biến môi trường
  db/                       Client better-sqlite3, schema.sql, seed.ts, repositories/
  middleware/authenticate.ts Xác thực JWT + kiểm tra vai trò
  modules/
    auth/                  Đăng nhập, làm mới token, đăng xuất, khôi phục mật khẩu
    devices/                Đăng ký/liệt kê/cấu hình/push-token thiết bị + sync_device
    videos/                 CRUD thư viện + luồng upload theo chunk
    rooms/                  Mã mời, sync_room, điều khiển quay + camera
    recording-sessions/     get_recording_session
    app/                    check_new_version
  plugins/                  Plugin fastify cho jwt, minio
  utils/                    Khuôn phản hồi, mã lỗi, kiểm tra dữ liệu đầu vào, băm mật khẩu
```
