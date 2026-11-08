# Chạy backend trên máy Mac cho mạng Wi-Fi nội bộ

Hướng dẫn bật **MinIO + backend** trên máy Mac để điện thoại (app Remote) và dashboard Controller
dùng trong cùng một mạng Wi-Fi — không cần VPS, domain hay HTTPS.

Cách build/cài app iOS lên iPhone nằm ở repo app: `horus-app/docs/ios-local-setup.md`.

Mọi lệnh chạy trong Terminal trên Mac. Mac và điện thoại phải dùng **cùng một mạng Wi-Fi**.

---

## 0. Tổng quan

| Thành phần | Chạy ở đâu | Cổng |
|---|---|---|
| Colima (Docker) | Mac | — |
| MinIO (lưu video) | Docker container `multicam-server-minio-1` | 9000 (S3), 9001 (trang quản trị) |
| Backend (repo này, nhánh `feat/android-recorder`) | `npm run dev` trên Mac | 3000 (API + dashboard), 40100–40199 (WebRTC) |
| Dashboard Controller | Trình duyệt trên Mac: `http://localhost:3000/` | — |

Thứ tự bật: **Colima → MinIO → Backend.** Backend phải bật **sau** MinIO: lúc khởi động nó kết
nối MinIO ngay, MinIO chưa chạy thì backend báo lỗi và dừng.

> Không dùng `docker compose up` của nhánh này cho mạng LAN: compose chỉ mở MinIO và API cho
> `127.0.0.1`, điện thoại sẽ không upload được.

Trong hướng dẫn, `192.168.0.116` là **ví dụ** IP của Mac — thay bằng IP thật của bạn (mục 1).
Cổng `3000` là giá trị mặc định của `PORT` trong `.env`; nếu bạn đổi `PORT` thì thay `3000` ở
mọi chỗ trong hướng dẫn (link dashboard, `/health`, Server URL trong app) bằng cổng mới.

---

## 1. Xem IP hiện tại của Mac (và sửa khi IP đổi)

```bash
ipconfig getifaddr en0
```

IP này **có thể đổi** khi bạn chuyển sang mạng Wi-Fi khác (ở nhà → ở trường, quán cà phê…) hoặc
khi router cấp lại IP (sau khi khởi động lại router, Mac ngủ lâu…). Nên chạy lệnh trên **mỗi lần
bắt đầu dùng**. Nếu IP vẫn như lần trước thì bỏ qua phần ví dụ dưới.

### Ví dụ: IP đổi từ `192.168.0.116` sang `192.168.1.25`

**Bước 1 — Phát hiện IP đã đổi.** Lần trước `.env` đang dùng `192.168.0.116`, hôm nay chạy:

```bash
$ ipconfig getifaddr en0
192.168.1.25
```

Dấu hiệu khác khi quên kiểm tra: app trên điện thoại báo **Kiểm tra kết nối** thất bại, preview
trên dashboard đen, hoặc quay xong video không upload được.

**Bước 2 — Sửa `.env` của backend.** Mở `~/Documents/multicam-server/.env`, đổi 2 dòng chứa IP:

```diff
- MINIO_PUBLIC_ENDPOINT=192.168.0.116
+ MINIO_PUBLIC_ENDPOINT=192.168.1.25
  MINIO_PUBLIC_PORT=9000
  MINIO_PUBLIC_USE_SSL=false
- MEDIASOUP_ANNOUNCED_IP=192.168.0.116
+ MEDIASOUP_ANNOUNCED_IP=192.168.1.25
```

Hoặc sửa nhanh bằng một lệnh (tự lấy IP hiện tại và đặt đủ 4 dòng — dùng được cả khi `.env` vừa
bị ghi đè bằng `.env.example`):

```bash
cd ~/Documents/multicam-server
IP=$(ipconfig getifaddr en0)
sed -i '' -e "s/^MINIO_PUBLIC_ENDPOINT=.*/MINIO_PUBLIC_ENDPOINT=$IP/" \
          -e "s/^MINIO_PUBLIC_PORT=.*/MINIO_PUBLIC_PORT=9000/" \
          -e "s/^MINIO_PUBLIC_USE_SSL=.*/MINIO_PUBLIC_USE_SSL=false/" \
          -e "s/^MEDIASOUP_ANNOUNCED_IP=.*/MEDIASOUP_ANNOUNCED_IP=$IP/" .env
grep -E "^(MINIO_PUBLIC_|MEDIASOUP_ANNOUNCED_IP)" .env     # kiểm tra lại: đủ 4 dòng, đúng IP
```

**Bước 3 — Bật (hoặc bật lại) backend.** Backend chỉ đọc `.env` lúc khởi động, và luôn bật
**sau** Colima + MinIO:

- **Mới bắt đầu, chưa bật gì:** sửa `.env` xong thì làm tiếp mục 2 (Colima, MinIO) rồi mục 3
  (`npm run dev`) như bình thường — không có gì phải "chạy lại".
- **Backend đang chạy mới phát hiện IP đổi:** để nguyên Colima và MinIO; ở cửa sổ đang chạy
  `npm run dev` bấm **Ctrl + C**, rồi chạy lại:

  ```bash
  npm run dev
  ```

Kiểm tra từ điện thoại: mở Safari vào `http://192.168.1.25:3000/health` → phải thấy
`"status":"up"`.

**Bước 4 — Sửa Server URL trong app trên điện thoại.** Đổi `http://192.168.0.116:3000` thành
`http://192.168.1.25:3000`:

- Chưa đăng nhập: ở màn hình đăng nhập, mở **Kết nối server**, sửa **Server URL**, bấm
  **Kiểm tra kết nối** → thấy **Server phản hồi tốt**.
- Đã đăng nhập: tab **Cài đặt** → **Server URL** → sửa → **Lưu** → **Test**.

Làm cho **từng điện thoại** đang dùng.

**Không cần sửa:**

- Dashboard trên Mac: vẫn mở `http://localhost:3000/` (`localhost` luôn là chính máy Mac).
- MinIO / Colima: không phụ thuộc IP, không cần khởi động lại.
- Video đã upload trước đó: vẫn còn; link tải được tạo mới mỗi lần bấm nên tự dùng IP mới.

> Nếu dùng **bản Debug** của app thì địa chỉ Metro cũng đổi theo (`http://192.168.1.25:8081`) —
> xem `horus-app/docs/ios-local-setup.md`, mục 5.

---

## 2. Bật Colima và MinIO

```bash
colima start
docker start multicam-server-minio-1
```

Kiểm tra MinIO (phải in ra `200`):

```bash
curl -s -o /dev/null -w "%{http_code}\n" http://$(ipconfig getifaddr en0):9000/minio/health/live
```

Trang quản trị MinIO: `http://localhost:9001` (đăng nhập `minioadmin` / `minioadmin`), video nằm
trong bucket `multicam-videos`.

> **Nếu container `multicam-server-minio-1` không còn** (`docker ps -a` không thấy), tạo lại bằng
> image trên Docker Hub (image trên `quay.io` từng trả lỗi 401):
>
> ```bash
> docker run -d --name multicam-server-minio-1 --restart unless-stopped \
>   -p 9000:9000 -p 9001:9001 -v minio-dev-data:/data \
>   minio/minio:latest server /data --console-address ":9001"
> ```
>
> Container mới có kho dữ liệu trống: video cũ không còn, backend tự tạo lại bucket.

---

## 3. Bật backend

### Lần đầu (hoặc khi clone lại repo)

```bash
cd ~/Documents/multicam-server
git switch feat/android-recorder
npm ci
cp -n .env.example .env     # -n: chỉ tạo khi chưa có .env, không ghi đè file đã cấu hình
```

> ⚠️ Đừng chạy `cp .env.example .env` (không có `-n`) khi đã có `.env`: lệnh đó **ghi đè** và làm
> trống các dòng IP bên dưới → preview không lên hình và điện thoại không upload được.

Trong `.env`, sửa các dòng sau theo IP của Mac (mục 1):

```
MINIO_PUBLIC_ENDPOINT=192.168.0.116
MINIO_PUBLIC_PORT=9000
MINIO_PUBLIC_USE_SSL=false
MEDIASOUP_ANNOUNCED_IP=192.168.0.116
```

- `MINIO_PUBLIC_*`: link upload/tải video trỏ về IP của Mac thay vì `localhost`, điện thoại mới
  dùng được.
- `MEDIASOUP_ANNOUNCED_IP`: để preview (WebRTC) lên hình.

`.env` không được commit (đã có trong `.gitignore`).

### Mỗi lần dùng

Để cửa sổ Terminal này mở trong suốt lúc dùng:

```bash
cd ~/Documents/multicam-server && npm run dev
```

Kiểm tra:

```bash
curl http://localhost:3000/health          # → "status":"up"
```

Từ điện thoại, mở Safari vào `http://192.168.0.116:3000/health` cũng phải thấy `"status":"up"`.

---

## 4. Dùng dashboard (Controller)

1. Mở `http://localhost:<PORT>/` trên Mac (mặc định `http://localhost:3000/`), đăng nhập
   `0900000001` / `Controller@123`.
2. **Quản lý phòng → + Tạo phòng**, gửi **Mã mời** cho người cầm điện thoại.
3. Điện thoại Join phòng và bấm **📡 Phát sóng** (Controller không tự bật camera của điện thoại được).
4. **▶ Bật preview** để xem; **● Ghi ALL** / **■ Dừng ALL** để quay. Sau Dừng ALL bấm **OK** ở hộp
   thông báo (trang bị chặn tới khi bấm).
5. Điện thoại tự upload khi dừng. **Video trên server → Tải lại → ▶ Xem / ⬇ Tải.**

Tài khoản demo (tự tạo khi backend khởi động):

| Vai trò | Số điện thoại | Mật khẩu |
|---|---|---|
| Controller | `0900000001` | `Controller@123` |
| Remote | `0900000002`, `0900000003`, `0900000004` | `Remote@123` |

**Server URL nhập trong app điện thoại** có dạng `http://<IP của Mac>:<PORT>`:

- `<IP của Mac>`: kết quả của `ipconfig getifaddr en0` (mục 1) — **không** dùng `localhost`, vì
  trên điện thoại `localhost` là chính điện thoại.
- `<PORT>`: giá trị `PORT` trong `.env` của backend (mặc định `3000`). Xem nhanh:
  `grep ^PORT= ~/Documents/multicam-server/.env`.

Ví dụ: IP là `192.168.0.116`, `PORT=3000` → nhập `http://192.168.0.116:3000`.
Nếu đổi `PORT=3100` (vì cổng 3000 đã bị chương trình khác dùng) → `http://192.168.0.116:3100`.

---

## 5. Tắt sau khi dùng

```bash
# Ctrl + C ở cửa sổ đang chạy npm run dev
docker stop multicam-server-minio-1
colima stop
```

Dữ liệu không mất: video nằm trong Docker volume của MinIO; tài khoản, phòng và danh sách video
nằm ở `data/multicam.sqlite3`.

---

## 6. Lỗi thường gặp

| Hiện tượng | Nguyên nhân / cách sửa |
|---|---|
| `docker`: `Cannot connect to the Docker daemon` / `colima.sock: no such file` | Colima chưa chạy: `colima start`. |
| Backend dừng ngay khi khởi động, lỗi kết nối MinIO | MinIO chưa chạy hoặc chưa sẵn sàng: `docker start multicam-server-minio-1`, đợi vài giây rồi `npm run dev` lại. |
| `docker run` báo `401 UNAUTHORIZED` từ `quay.io` | Dùng image `minio/minio:latest` trên Docker Hub (mục 2). |
| Điện thoại **Kiểm tra kết nối** thất bại | Backend chưa chạy, sai IP, hoặc điện thoại khác mạng Wi-Fi. Mở `http://<IP>:3000/health` bằng trình duyệt trên điện thoại để thử. Wi-Fi công cộng/khách thường chặn các máy nói chuyện với nhau. |
| Preview không lên **và** quay xong không upload | Gần như chắc chắn các dòng IP trong `.env` đang trống/sai (hay gặp khi lỡ ghi đè `.env` bằng `.env.example`). Kiểm tra: `grep -E "^(MINIO_PUBLIC_|MEDIASOUP_ANNOUNCED_IP)" .env`; sửa theo mục 1–3 rồi chạy lại backend. |
| Preview trên dashboard đen | Điện thoại chưa bấm **Phát sóng**, hoặc `MEDIASOUP_ANNOUNCED_IP` sai IP. |
| Quay xong không thấy video | Bấm **Tải lại**, đợi điện thoại upload xong. Kiểm tra 3 dòng `MINIO_PUBLIC_*`; từ điện thoại mở `http://<IP>:9000` phải thấy trang lỗi XML của MinIO (tức là kết nối được). |
| Link tải video chỉ mở được trên Mac | `MINIO_PUBLIC_ENDPOINT` đang để trống/`localhost`. Sửa theo mục 3 rồi chạy lại backend. |
| Preview trên dashboard không có tiếng | Bình thường: dashboard được viết để tắt tiếng (`public/index.html`). Video đã ghi vẫn có tiếng. |
