# Multi-Cam Recorder Backend — Tài liệu API

*English: [API.md](API.md)*

Bản này hiện thực mốc 15/8 trong `specs/v3_GiaoDien_TichHop_API_MultiCamRecorder.md`:

1. Đăng nhập với 4 tài khoản mặc định (1 Controller + 3 Remote).
2. Upload video dạng chunk từ máy Remote lên MinIO, hỗ trợ tiếp tục upload dở
   dang và chống trùng, kèm đủ phần thư viện/tải xuống để máy Controller liệt
   kê và tải clip về — đủ để demo trọn luồng quay → upload → lấy về.

Điều khiển phòng/phiên quay, socket, thông báo và push token thiết bị **chưa**
được cài đặt — các phần này thuộc mốc 22/8 và 29/8 theo lộ trình trong tài
liệu đặc tả (mục "LỘ TRÌNH LÀM VIỆC").

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

### `POST /devices` 🔒
Đăng ký (hoặc cập nhật) thiết bị một cách tường minh, tương đương `register_device` trong đặc tả.
Body: `{ "device_id", "device_type", "device_name", "model?", "os_version?", "capabilities?" }`.

### `GET /devices` 🔒
Liệt kê các thiết bị đã đăng ký dưới tài khoản đang gọi (tương đương `get_device_list`, hiện chỉ giới hạn trong phạm vi chính tài khoản đó — chưa hỗ trợ tham số `user_id` dành cho admin như trong đặc tả).

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

- Chưa có API phòng/phiên quay, socket hay thông báo (dự kiến từ mốc 22/8 trở đi).
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
    auth/                  Đăng nhập, làm mới token, đăng xuất
    devices/                Đăng ký + liệt kê thiết bị
    videos/                 CRUD thư viện + luồng upload theo chunk
  plugins/                  Plugin fastify cho jwt, minio
  utils/                    Khuôn phản hồi, mã lỗi, kiểm tra dữ liệu đầu vào, băm mật khẩu
```
