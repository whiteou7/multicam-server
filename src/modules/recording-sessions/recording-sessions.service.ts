/**
 * RecordingSessions Service — quản lý metadata phiên ghi trên MinIO.
 *
 * Khi một phiên (recording_sessions) bị setStopped (Dừng ALL hoặc đóng phòng),
 * service này tổng hợp thông tin phiên + danh sách thiết bị tham gia → ghi
 * ra file `session.json` trong cùng folder chứa các file MP4 của phiên đó,
 * để admin/người dùng mở MinIO Object Browser nhìn vào folder phiên là có
 * ngay thông tin phiên (ngày giờ, thiết bị nào tham gia, model máy, camera name...).
 *
 * Cấu trúc folder trên MinIO theo yêu cầu mới (chung cả 2 luồng server-ghi / client-upload
 * đều đẩy MP4 vào cùng folder):
 *   {room_id} / {session_id}_{YYYYMMDD_HHmmss (VN time)} /
 *     session.json
 *     {device_id}_{brand(samsung|iphone|...)}_{VNtime}.mp4   (từng thiết bị 1 file)
 */

import { randomUUID } from "node:crypto";
import { FastifyInstance } from "fastify";
import { env } from "../../config/env";
import { roomsRepo } from "../../db/repositories/rooms.repo";
import { recordingSessionsRepo, RecordingSessionRow } from "../../db/repositories/recording-sessions.repo";
import { roomMembersRepo } from "../../db/repositories/room-members.repo";
import { devicesRepo } from "../../db/repositories/devices.repo";
import { videosRepo } from "../../db/repositories/videos.repo";
import { buildSessionFolderName, buildSessionJsonObjectKey } from "../../utils/vn-path";

/**
 * Tên folder phiên trên MinIO — resolve duy nhất từ `recording_sessions.started_at`.
 *
 * Mọi nơi tạo object key (session.json, MP4 ghi trên server, MP4 upload từ client)
 * PHẢI gọi hàm này. Nếu tự dựng tên folder từ thời điểm ghi (`rec.startedAt` /
 * `recorded_at`) thì lệch vài giây với `session.json` → tách 2 folder.
 *
 * Khi không tìm thấy session trong DB (quay độc lập, session_id không hợp lệ)
 * thì fallback về `fallbackAt` — lúc này cũng không có session.json để trùng tên.
 */
export function resolveSessionFolderName(
  sessionId: string,
  fallbackAt: string | number | Date
): string {
  const session = recordingSessionsRepo.findById(sessionId);
  if (!session?.started_at) {
    return buildSessionFolderName(sessionId, fallbackAt);
  }
  return buildSessionFolderName(sessionId, session.started_at);
}

export interface SessionDeviceInfo {
  member_id: string;
  device_id: string;
  device_type: number;
  camera_name: string;
  device_name: string | null;
  model: string | null;
  os_version: string | null;
  recording_state: string;
  elapsed_ms: number | null;
  upload_state: string | null;
  has_recording: 0 | 1;
  video_id: string | null;
}

export interface SessionMinIOMetadata {
  session_id: string;
  room_id: string;
  room_name: string | null;
  owner_id: string;
  started_at: string;
  stopped_at: string | null;
  duration_ms: number | null;
  status: string;
  device_count: number;
  devices: SessionDeviceInfo[];
  summary: {
    total_recorded_devices: number;
    total_duration_ms: number;
    total_size_bytes: number;
  };
  exported_at: string;
  exporter_version: string;
}

const EXPORTER_VERSION = "1.0.0";

async function safePutJson(app: FastifyInstance, objectKey: string, doc: SessionMinIOMetadata): Promise<void> {
  try {
    const json = JSON.stringify(doc, null, 2);
    const buffer = Buffer.from(json, "utf8");
    // minio.putObject(bucket, key, buffer, size, metadata) — phải ghi rõ size vị trí 4, metadata vị trí 5
    await app.minio.putObject(
      env.minio.bucket,
      objectKey,
      buffer,
      buffer.length,
      {
        "Content-Type": "application/json",
        session_id: doc.session_id,
        owner_id: doc.owner_id,
        exported_at: doc.exported_at,
      }
    );
    app.log.info({ objectKey }, "session metadata pushed to MinIO");
  } catch (e) {
    app.log.error({ err: e, objectKey }, "failed to push session metadata to MinIO");
  }
}

/**
 * Tạo metadata file cho một phiên và đẩy lên MinIO.
 *
 * Được gọi nền (không throw, không chặn caller) vì đây là metadata bổ trợ,
 * không phải luồng chính (MP4 vẫn được lưu dù file JSON bị lỗi).
 */
export async function finalizeSessionToMinIO(
  app: FastifyInstance,
  sessionId: string
): Promise<void> {
  try {
    const session = recordingSessionsRepo.findById(sessionId) as RecordingSessionRow | undefined;
    if (!session) {
      app.log.warn({ sessionId }, "finalizeSessionToMinIO: session not found, skip");
      return;
    }
    const room = roomsRepo.findById(session.room_id);
    if (!room) {
      app.log.warn({ sessionId, room_id: session.room_id }, "finalizeSessionToMinIO: room not found, skip");
      return;
    }

    const membersAll = roomMembersRepo.listAllByRoom(room.id);
    // Lọc những member đã join trong phạm vi session hiện tại (left_at=null hoặc left_revision>=session-start revision)
    // — cách đơn giản: dùng các member còn "active" ở thời điểm tạm dừng (chưa rời phòng)
    //   + cộng thêm các member đã rời nhưng đã có video của session này (đã upload).
    const deviceIdsSeen = new Set<string>();
    const devices: SessionDeviceInfo[] = [];

    for (const m of membersAll) {
      if (deviceIdsSeen.has(m.device_id)) continue;
      deviceIdsSeen.add(m.device_id);
      const dev = devicesRepo.findById(m.device_id);
      const video = videosRepo.findByDeviceAndSession(m.device_id, session.id);
      devices.push({
        member_id: m.id,
        device_id: m.device_id,
        device_type: dev?.device_type ?? 0,
        camera_name: m.camera_name ?? dev?.camera_name ?? "unknown",
        device_name: dev?.device_name ?? null,
        model: dev?.model ?? null,
        os_version: dev?.os_version ?? null,
        recording_state: m.recording_state ?? "idle",
        elapsed_ms: m.elapsed_ms ?? null,
        upload_state: m.upload_state ?? null,
        has_recording: video ? 1 : 0,
        video_id: video?.id ?? null,
      });
    }

    // Quét lại videos của session này để bổ sung những device đã rời khỏi room trước khi stop
    const vidsForSession = videosRepo.listBySession(session.id);
    for (const v of vidsForSession) {
      if (deviceIdsSeen.has(v.device_id)) continue;
      deviceIdsSeen.add(v.device_id);
      const dev = devicesRepo.findById(v.device_id);
      devices.push({
        member_id: `vid-${v.id}`,
        device_id: v.device_id,
        device_type: dev?.device_type ?? 0,
        camera_name: v.camera_name ?? dev?.camera_name ?? "unknown",
        device_name: dev?.device_name ?? null,
        model: dev?.model ?? null,
        os_version: dev?.os_version ?? null,
        recording_state: "saved",
        elapsed_ms: v.duration_ms ?? null,
        upload_state: "uploaded",
        has_recording: 1,
        video_id: v.id,
      });
    }

    let durationMs: number | null = null;
    if (session.started_at && session.stopped_at) {
      durationMs = Math.max(0, new Date(session.stopped_at).getTime() - new Date(session.started_at).getTime());
    }

    let totalSize = 0;
    let totalDuration = 0;
    let totalRecorded = 0;
    for (const d of devices) {
      if (d.has_recording === 1) {
        totalRecorded += 1;
        totalDuration += d.elapsed_ms ?? 0;
      }
    }
    for (const v of vidsForSession) {
      totalSize += v.size_bytes ?? 0;
      if (!durationMs && v.duration_ms) totalDuration += v.duration_ms;
    }

    const doc: SessionMinIOMetadata = {
      session_id: session.id,
      room_id: session.room_id,
      room_name: room.room_name ?? null,
      owner_id: room.owner_id,
      started_at: session.started_at,
      stopped_at: session.stopped_at,
      duration_ms: durationMs ?? (totalDuration > 0 ? totalDuration : null),
      status: session.status,
      device_count: devices.length,
      devices,
      summary: {
        total_recorded_devices: totalRecorded,
        total_duration_ms: totalDuration,
        total_size_bytes: totalSize,
      },
      exported_at: new Date().toISOString(),
      exporter_version: EXPORTER_VERSION,
    };

    // Đẩy session.json vào cùng folder chứa các file MP4 của phiên:
    //   {room_id} / {session_id}_{VNtime} / session.json
    // Dùng `session.started_at` đã fetch sẵn — cùng giá trị resolveSessionFolderName
    // trả về, nên folder khớp chính xác với folder của các MP4 trong phiên này.
    const sessionJsonKey = buildSessionJsonObjectKey(
      room.id,
      buildSessionFolderName(session.id, session.started_at)
    );
    await safePutJson(app, sessionJsonKey, doc);
  } catch (e) {
    app.log.error({ err: e, sessionId }, "finalizeSessionToMinIO crashed");
  }
}

/**
 * Background wrapper — fire-and-forget. Caller (stopRecording / closeRoom) không
 * chờ đợi đẩy MinIO xong mới trả response, tránh treo request "Dừng ALL" lâu.
 */
export function finalizeSessionToMinIOBackground(
  app: FastifyInstance,
  sessionId: string,
  label: string = "finalizeSessionToMinIO"
): void {
  const opId = randomUUID().slice(0, 8);
  void (async () => {
    try {
      app.log.info({ sessionId, opId, label }, `${label} queue started`);
      // Đợi 1 giây để stopRecord lệnh cuối cùng kịp ghi trạng thái final vào DB
      // (recorder ffmpeg finalize + insert videos row vẫn còn chạy nền vài trăm ms)
      await new Promise(r => setTimeout(r, 1_500));
      await finalizeSessionToMinIO(app, sessionId);
    } catch (err) {
      app.log.error({ err, sessionId, opId }, `${label} background crashed`);
    }
  })();
}
