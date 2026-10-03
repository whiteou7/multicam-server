export const VN_TZ = "Asia/Ho_Chi_Minh";
const VN_OFFSET_MS = 7 * 60 * 60 * 1000;

/** Segment thay thế room_id khi client quay ngoài phòng (không có room_id). */
export const STANDALONE_ROOM_SEGMENT = "_standalone";

function pad2(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

/**
 * Format thời gian theo múi giờ VN (UTC+7) dạng compact file-name safe:
 *   YYYYMMDD_HHmmss
 *  - Dùng để làm tên thư mục phiên (session_id + thời gian bắt đầu)
 *  - Dùng để làm tiền tố/gốc tên file video MP4
 */
export function formatVNDateTimeCompact(input: string | number | Date): string {
  const dt = typeof input === "string" || typeof input === "number" ? new Date(input) : input;
  if (Number.isNaN(dt.getTime())) {
    const now = new Date();
    return formatVNDateTimeCompact(now);
  }
  const vnMs = dt.getTime() + VN_OFFSET_MS;
  const vnDate = new Date(vnMs);
  // Khi cộng offset, getUTCFullYear()... sẽ cho ra giờ VN chính xác
  const y = vnDate.getUTCFullYear();
  const m = pad2(vnDate.getUTCMonth() + 1);
  const d = pad2(vnDate.getUTCDate());
  const hh = pad2(vnDate.getUTCHours());
  const mm = pad2(vnDate.getUTCMinutes());
  const ss = pad2(vnDate.getUTCSeconds());
  return `${y}${m}${d}_${hh}${mm}${ss}`;
}

/**
 * Rút gọn tên model điện thoại → tên brand short name để làm một phần
 * tên file MP4. Ưu tiên match theo keyword từ model string:
 *   Samsung Galaxy S24 Ultra  → "samsung"
 *   iPhone 15 Pro             → "iphone"
 *   Xiaomi Redmi Note 13      → "xiaomi"
 *   Pixel 8                   → "pixel"
 *   OPPO A79                  → "oppo"
 *   HUAWEI Pura 70            → "huawei"
 *   Vivo V40                  → "vivo"
 *   realme 12                 → "realme"
 *   còn lại                   → "phone"
 */
export function deviceBrandShortName(model?: string | null): string {
  if (!model) return "phone";
  const lower = String(model).toLowerCase();
  if (lower.includes("iphone")) return "iphone";
  if (lower.includes("samsung") || lower.includes("galaxy") || lower.startsWith("sm-")) return "samsung";
  if (lower.includes("xiaomi") || lower.includes("redmi") || lower.includes("poco")) return "xiaomi";
  if (lower.includes("pixel")) return "pixel";
  if (lower.includes("oppo")) return "oppo";
  if (lower.includes("huawei")) return "huawei";
  if (lower.includes("vivo")) return "vivo";
  if (lower.includes("realme")) return "realme";
  if (lower.includes("nokia")) return "nokia";
  if (lower.includes("oneplus") || lower.includes("1+")) return "oneplus";
  return "phone";
}

/**
 * Loại bỏ ký tự unsafe khỏi tên file/folder S3/MinIO.
 * Giữ lại: [a-zA-Z0-9._-] — các ký tự khác thay bằng "_".
 */
export function sanitizeObjectPath(part: string): string {
  if (!part) return "unknown";
  return String(part).replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 180) || "unknown";
}

/**
 * Build folder name của một phiên ghi trên MinIO theo cấu trúc mới:
 *   {session_id}_{VN datetime compact}
 * Ví dụ:   a1b2c3_20260330_154210
 */
export function buildSessionFolderName(sessionId: string, startedAt: string | number | Date | null | undefined): string {
  const safeSid = sanitizeObjectPath(sessionId) || "session";
  const timePart = startedAt ? formatVNDateTimeCompact(startedAt) : formatVNDateTimeCompact(new Date());
  return `${safeSid}_${timePart}`;
}

/**
 * Device id rút gọn, dùng làm định danh ngắn trong tên file và trên UI streaming.
 * Cắt 12 ký tự đầu → giữ được tiền tố + 5 chữ số đầu timestamp:
 *   `device_1790994782330_5d6iz1nwq` → `device_17909`
 *
 * LƯU Ý: 5 chữ số đầu timestamp có độ phân giải ~100 giây, nên 2 máy cùng tạo
 * trong vòng ~100s sẽ ra cùng short id. Chấp nhận được nếu mỗi máy một model riêng;
 * nếu cần duy nhất tuyệt đối thì thêm unique suffix lúc upload.
 */
export const SHORT_DEVICE_ID_LEN = 12;

export function shortDeviceId(deviceId: string | null | undefined): string {
  const safe = sanitizeObjectPath(deviceId ?? "");
  if (!safe || safe === "unknown") return "device";
  return safe.slice(0, SHORT_DEVICE_ID_LEN);
}

/**
 * Brand chi tiết để đặt tên file: ưu tiên `{brand}_{model}`, model đã chứa sẵn tên
 * hãng ở đầu thì không lặp lại.
 *
 *   model = "samsung SM-S931B" → "samsung_SM-S931B"
 *   model = "iPhone 15 Pro"    → "iPhone_15_Pro"   (đã chứa "iphone" → không lặp)
 *   model = null, device_name = "SM-S931B" → "SM-S931B"
 *   cả hai null                → "phone"
 */
export function deviceBrandDetail(
  model: string | null | undefined,
  deviceName?: string | null
): string {
  if (model?.trim()) {
    const safeModel = sanitizeObjectPath(model);
    const safeBrand = sanitizeObjectPath(deviceBrandShortName(model));
    const alreadyHasBrand =
      safeBrand !== "phone" && safeModel.toLowerCase().startsWith(safeBrand.toLowerCase());
    return alreadyHasBrand ? safeModel : `${safeBrand}_${safeModel}`;
  }
  if (deviceName?.trim()) return sanitizeObjectPath(deviceName);
  return "phone";
}

/**
 * Build filename một video MP4 cho một thiết bị theo cấu trúc mới:
 *   {short device_id}_{brand chi tiết}_{VN datetime compact}.mp4
 * Không thêm suffix — mỗi thiết bị 1 file duy nhất trong 1 phiên.
 */
export function buildMp4FileName(
  deviceId: string,
  deviceModel: string | null | undefined,
  recordedAt: string | number | Date | null | undefined,
  deviceName?: string | null
): string {
  const idPart = shortDeviceId(deviceId);
  const brand = deviceBrandDetail(deviceModel, deviceName);
  const timePart = recordedAt ? formatVNDateTimeCompact(recordedAt) : formatVNDateTimeCompact(new Date());
  return `${idPart}_${brand}_${timePart}.mp4`;
}

/**
 * Object key của một file session.json — nằm cùng folder với các MP4 của phiên:
 *   {room_id} / {sessionFolder} / session.json
 *
 * `sessionFolder` PHẢI là kết quả của `resolveSessionFolderName()` (resolve từ
 * `recording_sessions.started_at`) — đây là hợp đồng bắt buộc để `session.json`
 * và các MP4 luôn nằm cùng một folder.
 */
export function buildSessionJsonObjectKey(roomId: string, sessionFolder: string): string {
  return `${sanitizeObjectPath(roomId)}/${sessionFolder}/session.json`;
}

/**
 * Object key của một video MP4 — nguồn sự thật duy nhất cho cấu trúc folder MinIO:
 *   {room_id} /
 *     {sessionFolder} /
 *       session.json
 *       {device_id}_{brand}_{recordedAt (VN)}.mp4
 *
 * `sessionFolder` PHẢI là kết quả của `resolveSessionFolderName()` — cùng hợp đồng
 * với `buildSessionJsonObjectKey`, đảm bảo 2 loại file không bị tách folder.
 * `recordedAt` chỉ dùng cho TÊN FILE (thời điểm clip đó thực sự được ghi).
 *
 * Khi client không gửi room_id (quay độc lập ngoài phòng), dùng segment `_standalone`
 * để cấu trúc 3 cấp vẫn được giữ nguyên thay vì rơi về layout phẳng `videos/...`.
 */
export function buildVideoObjectKey(
  roomId: string | null | undefined,
  sessionFolder: string,
  deviceId: string,
  deviceModel: string | null | undefined,
  recordedAt: string | number | Date | null | undefined,
  deviceName?: string | null
): string {
  const roomSegment = roomId?.trim() ? sanitizeObjectPath(roomId.trim()) : STANDALONE_ROOM_SEGMENT;
  const mp4Name = buildMp4FileName(deviceId, deviceModel, recordedAt, deviceName);
  return `${roomSegment}/${sessionFolder}/${mp4Name}`;
}
