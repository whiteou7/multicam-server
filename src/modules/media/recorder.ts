/**
 * Recorder Service — ghi âm/video phát sóng ngay trên server.
 *
 * Mỗi khi một Remote produce audio/video qua mediasoup ("Phát sóng"), server
 * mở PlainRtpTransport nội bộ, consume producer đó và pipe RTP (copy nguyên
 * codec — không transcode) sang ffmpeg ghi ra file MP4. Khi member dừng phát /
 * rời phòng / room đóng, recorder finalize file rồi đẩy lên MinIO và insert
 * vào bảng videos (hiện trong mục Videos của chủ phòng).
 *
 * Windows notes:
 *  - spawn() luôn dùng windowsHide để không bắn cửa sổ cmd.
 *  - KHÔNG dùng child.kill('SIGTERM'/SIGINT) để dừng ffmpeg (Windows terminate
 *    cứng làm hỏng moov). Dừng bằng cách ghi 'q' vào stdin, kèm -movflags
 *    frag_keyframe+empty_moov làm safety nếu vẫn bị terminate.
 *  - ffmpeg đọc RTP qua UDP loopback (127.0.0.1) — không vướng firewall.
 */

import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import dgram from "node:dgram";
import { randomUUID } from "node:crypto";
import { FastifyInstance } from "fastify";
import * as mediasoup from "mediasoup";
import { env } from "../../config/env";
import { roomsRepo } from "../../db/repositories/rooms.repo";
import { roomMembersRepo } from "../../db/repositories/room-members.repo";
import { devicesRepo } from "../../db/repositories/devices.repo";
import { videosRepo } from "../../db/repositories/videos.repo";
import { buildVideoObjectKey } from "../../utils/vn-path";
import { resolveSessionFolderName } from "../recording-sessions/recording-sessions.service";
import { RoomMedia } from "./media.state";

interface StreamRec {
  kind: "audio" | "video";
  producer: mediasoup.types.Producer;
  consumer: mediasoup.types.Consumer;
  transport: mediasoup.types.PlainTransport;
  /** Cổng UDP mà ffmpeg sẽ bind để nhận RTP (đã pass vào transport.connect) */
  rtpPort: number;
  closed: boolean;
  /** packetCount video gần nhất (từ consumer.getStats) — để detect nguồn ngừng gửi */
  lastPktCount: number;
  /** số tick liên tiếp không nhận packet mới (tick = 2s) */
  stallTicks: number;
  stallLogged: boolean;
}

interface MemberRecorder {
  memberId: string;
  /** Session đang active lúc producer xuất hiện (Ghi ALL) — nhóm các video 1 lần quay */
  sessionId: string | null;
  deviceId: string;
  /** 1=Remote, 3=Controller web, 4=Web — ghi vào metadata MP4 để nhận diện loại máy */
  deviceType: number;
  /** Model điện thoại thật (VD "Samsung SM-G991B") — ghi vào metadata MP4 */
  deviceModel: string;
  /** Tên thiết bị user tự đặt (VD "SM-S931B") — fallback khi model rỗng */
  deviceName: string;
  cameraName: string;
  streams: StreamRec[];
  ffmpeg: ChildProcess | null;
  sdpFile: string;
  outFile: string;
  startedAt: number;
  startTimer: NodeJS.Timeout | null;
  stopping: boolean;
  /** Pump PLI định kỳ (2s) — giữ keyframe tới mọi consumer (controller, ffmpeg) */
  keyframeTimer: NodeJS.Timeout | null;
  /** 60 dòng cuối stderr của ffmpeg — để debug khi file ra bị rỗng/khó hiểu */
  stderrTail: string[];
}

const defaultTmpDir = env.recording.tmpDir;
ensureDirSync(defaultTmpDir);

function ensureDirSync(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

/** Tìm 1 cổng UDP trống (ffmpeg sẽ bind cổng này để nhận RTP). */
function getFreeUdpPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const sock = dgram.createSocket("udp4");
    sock.once("error", reject);
    sock.bind(0, "127.0.0.1", () => {
      const port = sock.address().port;
      sock.close(() => resolve(port));
    });
  });
}

/** Build SDP mô tả các stream sẽ được ffmpeg nhận qua `m=<addr> <rtpPort>`. */
function buildSdp(streams: StreamRec[]): string {
  const header = [
    "v=0",
    `o=- ${Date.now()} ${Date.now()} IN IP4 127.0.0.1`,
    "s=multicam-recorder",
    "t=0 0",
  ].join("\n");

  const blocks: string[] = [];
  for (const s of streams) {
    const params = s.consumer.rtpParameters;
    const codec = params.codecs[0];
    const pt = codec.payloadType;
    const encoding = params.encodings?.[0];
    const ssrc = encoding?.ssrc ?? 0;
    const clockRate = codec.clockRate ?? 90000;
    const codecName = codec.mimeType.split("/")[1] ?? codec.mimeType;
    const channels = s.kind === "audio" ? codec.channels ?? 2 : undefined;

    const lines = [
      `m=${s.kind} ${s.rtpPort} RTP/AVP ${pt}`,
      "c=IN IP4 127.0.0.1",
      `a=rtpmap:${pt} ${codecName}/${clockRate}${channels ? "/" + channels : ""}`,
    ];
    const fmtps = Object.entries(codec.parameters ?? {});
    if (fmtps.length) {
      lines.push(`a=fmtp:${pt} ${fmtps.map(([k, v]) => `${k}=${v}`).join(";")}`);
    }
    lines.push(`a=ssrc:${ssrc} cname:multicam-recorder`);
    lines.push("a=rtcp-mux");
    lines.push("a=recvonly");

    blocks.push(lines.join("\n"));
  }

  return header + "\n" + blocks.join("\n") + "\n";
}

/**
 * Watchdog timeout cho upload MinIO. minio-js KHÔNG đặt socket timeout
 * (http.request không có `timeout`) nên một part kẹt trên mạng có thể treo
 * `fPutObject` vĩnh viễn. Với timeout này ta KHÔNG hủy request đang chạy
 * (nó vẫn hoàn tất nền nếu mạng hồi phục) mà chỉ thôi chờ đợi, để luồng
 * dừng phát không bao giờ bị block vô hạn.
 */
function withTimeout<T>(
  p: Promise<T>,
  ms: number
): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> {
  return new Promise((resolve) => {
    const timer = setTimeout(
      () => resolve({ ok: false, error: new Error(`upload stalled after ${ms}ms`) }),
      ms
    );
    p.then(
      (value) => {
        clearTimeout(timer);
        resolve({ ok: true, value });
      },
      (error) => {
        clearTimeout(timer);
        resolve({ ok: false, error });
      }
    );
  });
}

/**
 * Lấy duration THẬT (ms) của file MP4 bằng ffprobe. Trả về null nếu ffprobe
 * không có / file không parse được (khi đó caller fallback về wallclock).
 * Dùng để metadata duration_ms khớp với nội dung file, tránh trường hợp file
 * rỗng mà vẫn báo "video 111s" như trước.
 */
function probeDurationMs(file: string): Promise<number | null> {
  return new Promise((resolve) => {
    let proc: ChildProcess;
    try {
      proc = spawn(
        env.recording.ffprobePath,
        [
          "-v", "error",
          "-show_entries", "format=duration",
          "-of", "default=noprint_wrappers=1:nokey=1",
          file,
        ],
        { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] }
      );
    } catch {
      resolve(null);
      return;
    }
    let out = "";
    proc.stdout?.on("data", (chunk: Buffer) => {
      out += chunk.toString();
    });
    proc.on("error", () => resolve(null));
    proc.on("exit", (code) => {
      if (code !== 0) {
        resolve(null);
        return;
      }
      const sec = Number.parseFloat(out.trim());
      resolve(Number.isFinite(sec) && sec > 0 ? Math.round(sec * 1000) : null);
    });
  });
}

class RecorderService {
  private readonly map = new Map<string, Map<string, MemberRecorder>>(); // roomId -> (memberId -> recorder)
  /**
   * Producer mới đến trong lúc recorder cũ của cùng member còn đang finalize
   * (rec.stopping = true) → KHÔNG bỏ đi, mà xếp hàng để khởi động lại recorder
   * ngay khi recorder cũ dọn xong. Trước đây bị `return` luôn nên lần phát lại
   * không được ghi (restart nhanh).
   */
  private readonly pending = new Map<
    string,
    { app: FastifyInstance; roomMedia: RoomMedia; roomId: string; memberId: string; producers: mediasoup.types.Producer[] }
  >();
  private loggedArmed = false;

  private roomMap(roomId: string): Map<string, MemberRecorder> {
    let m = this.map.get(roomId);
    if (!m) {
      m = new Map();
      this.map.set(roomId, m);
    }
    return m;
  }

  /** Bắt đầu ghi cho 1 producer của member (audio hoặc video). */
  public async start(
    app: FastifyInstance,
    roomMedia: RoomMedia,
    roomId: string,
    memberId: string,
    producer: mediasoup.types.Producer
  ): Promise<void> {
    if (!this.loggedArmed) {
      this.loggedArmed = true;
      app.log.info(
        { on: env.recording.on, ffmpeg: env.recording.ffmpegPath, tmpDir: env.recording.tmpDir },
        "recorder service armed"
      );
    }
    if (!env.recording.on) return;

    const roomRecorders = this.roomMap(roomId);
    let rec = roomRecorders.get(memberId);
    if (rec?.stopping) {
      // Recorder cũ đang finalize (gracefulFfmpegStop có thể chờ tới 15s). Producer
      // mới của cùng member (thường là do user bật lại phát sóng) phải được GHI,
      // nên xếp hàng lại rồi khởi động khi recorder cũ dọn xong.
      let q = this.pending.get(memberId);
      if (!q) {
        q = { app, roomMedia, roomId, memberId, producers: [] };
        this.pending.set(memberId, q);
      }
      q.producers.push(producer);
      app.log.info({ roomId, memberId, kind: producer.kind }, "recorder busy stopping — queued producer for restart");
      return;
    }
    if (rec?.streams.some((s) => s.producer.id === producer.id)) return;

    if (!rec) {
      const metaRoom = roomsRepo.findById(roomId);
      const metaMember = roomMembersRepo.findById(memberId);
      const metaDevice = metaMember ? devicesRepo.findById(metaMember.device_id) : undefined;
      // timestamp dùng chung cho cặp file sdp+mp4 của lần quay này → không ghi đè
      // lên file của lần phát sóng trước (giữ lại toàn bộ lịch sử trong data)
      const stamp = Date.now();
      rec = {
        memberId,
        sessionId: metaRoom?.session_id ?? null,
        deviceId: metaMember?.device_id ?? memberId,
        deviceType: metaDevice?.device_type ?? 0,
        deviceModel: metaDevice?.model ?? "",
        deviceName: metaDevice?.device_name ?? "",
        cameraName: metaMember?.camera_name ?? `Remote-${memberId.slice(-4)}`,
        streams: [],
        ffmpeg: null,
        sdpFile: path.join(defaultTmpDir, `rec_${roomId.slice(0, 8)}_${memberId.slice(0, 8)}_${stamp}.sdp`),
        outFile: path.join(defaultTmpDir, `rec_${roomId.slice(0, 8)}_${memberId.slice(0, 8)}_${stamp}.mp4`),
        startedAt: Date.now(),
        startTimer: null,
        stopping: false,
        keyframeTimer: null,
        stderrTail: [],
      };
      roomRecorders.set(memberId, rec);
    }

    let stream = await this.openStream(app, roomMedia, roomId, rec, producer);
    if (!stream) {
      // openStream có thể fail tạm thời (worker/router đang bận lúc nhiều máy cùng
      // produce) — thử lại 1 lần trước khi bỏ, tránh mất bản ghi của cả một máy.
      await new Promise((r) => setTimeout(r, 500));
      stream = await this.openStream(app, roomMedia, roomId, rec, producer);
    }
    if (!stream) {
      // openStream fail trong lúc media chưa có stream nào → recorder rỗng vô dụng,
      // dọn luôn để không kẹt map (nếu để lại, producer kế tiếp tưởng recorder tồn tại).
      if (rec.streams.length === 0 && !rec.ffmpeg) {
        roomRecorders.delete(memberId);
      }
      return;
    }

    // Nếu ffmpeg đã chạy (nhánh hiếm: producer thứ 2 tới quá muộn) thì không
    // gắn thêm được vào SDP — bỏ qua stream đó.
    if (rec.ffmpeg) {
      app.log.warn({ roomId, memberId, kind: producer.kind }, "recorder ffmpeg already running, skip late stream");
      stream.closed = true;
      await this.closeStream(stream);
      return;
    }

    // Debounce đủ lâu để audio+video kịp tụ lại trong cùng 1 SDP / 1 ffmpeg
    // (app thường produce audio trước, video sau ~0.3-1s).
    if (!rec.startTimer) {
      rec.startTimer = setTimeout(() => {
        rec!.startTimer = null;
        this.spawnFfmpeg(app, roomId, rec!);
        for (const s of rec!.streams) {
          if (s.closed) continue;
          s.consumer.resume().catch(() => undefined);
          // Ép producer bơm keyframe ngay — VP8 không có SPS/PPS, nếu ffmpeg start
          // giữa GOP sẽ decode trễ; hơn nữa muxer mp4 cần keyframe đầu. Gọi 2 lần.
          void this.requestKeyframe(s.consumer);
        }
        // Keyframe pump 1s: producer chỉ gửi keyframe khi được yêu cầu (PC từng
        // consume chỉ còn delta frame) → controller/preview sẽ "đen" tới khi
        // có keyframe. Pump định kỳ giữ mọi consumer nhận keyframe ổn định.
        rec!.keyframeTimer = setInterval(() => {
          for (const s of rec!.streams) {
            if (s.closed || s.kind !== "video") continue;
            void this.requestKeyframe(s.consumer);
            void this.monitorFlow(app, rec!, s);
          }
        }, 1000);
      }, 1200);
    }
  }

  private async requestKeyframe(consumer: mediasoup.types.Consumer): Promise<void> {
    if (consumer.kind !== "video") return;
    try {
      await consumer.requestKeyFrame();
      await new Promise((r) => setTimeout(r, 300));
      if (!consumer.closed) await consumer.requestKeyFrame();
    } catch {
      /* producer có thể không hỗ trợ PLI — bỏ qua */
    }
  }

  /** Đếm packet video qua consumer.getStats: phát hiện producer ngừng gửi hàng loạt.
   *  tick = 1s (keyframeTimer); >=3 tick (~3s) không có packet mới → cảnh báo + log
   *  lúc nối lại. Giúp phân biệt "nguồn ngừng gửi" (màn hình tối/background) với
   *  "thiếu keyframe". */
  private async monitorFlow(
    app: FastifyInstance,
    rec: MemberRecorder,
    stream: StreamRec
  ): Promise<void> {
    try {
      const stats = await stream.consumer.getStats();
      const item = stats.find(
        (x) => (x as { rtpStream?: { packetCount?: number } }).rtpStream?.packetCount != null
      );
      const pkt = (item as { rtpStream?: { packetCount?: number } } | undefined)
        ?.rtpStream?.packetCount ?? -1;
      if (pkt < 0) return;
      if (pkt === stream.lastPktCount) {
        stream.stallTicks += 1;
      } else {
        stream.lastPktCount = pkt;
        stream.stallTicks = 0;
      }
      if (stream.stallTicks >= 3 && !stream.stallLogged) {
        stream.stallLogged = true;
        app.log.warn(
          { roomId: rec.memberId, memberId: rec.memberId, stallSeconds: stream.stallTicks },
          "OBS: video producer tạm ngừng gửi packets (nguồn/theo dõi liên tục)"
        );
      } else if (stream.stallLogged && stream.stallTicks < 3) {
        stream.stallLogged = false;
        app.log.warn({ memberId: rec.memberId }, "OBS: video producer nối lại (sau ~[stopped]s)");
      }
    } catch {
      /* getStats không sẵn sàng — bỏ qua tick này */
    }
  }

  private async openStream(
    app: FastifyInstance,
    roomMedia: RoomMedia,
    roomId: string,
    rec: MemberRecorder,
    producer: mediasoup.types.Producer
  ): Promise<StreamRec | null> {
    let transport: mediasoup.types.PlainTransport | undefined;
    try {
      const rtpPort = await getFreeUdpPort();
      transport = await roomMedia.router.createPlainTransport({
        listenIp: { ip: "127.0.0.1" },
        rtcpMux: true,
        comedia: false,
      });
      const consumer = await transport.consume({
        producerId: producer.id,
        // PlainTransport bắt buộc có rtpCapabilities (không tự fallback như Pipe).
        // Truyền capabilities của Router — consumer sẽ negotiate xuống đúng codec của producer.
        rtpCapabilities: roomMedia.router.rtpCapabilities,
        paused: true,
      });
      await transport.connect({ ip: "127.0.0.1", port: rtpPort });

      const stream: StreamRec = {
        kind: producer.kind,
        producer,
        consumer,
        transport,
        rtpPort,
        closed: false,
        lastPktCount: -1,
        stallTicks: 0,
        stallLogged: false,
      };

      const onClosed = () => {
        if (stream.closed) return;
        stream.closed = true;
        // Dừng + lưu khi member không còn stream nào đang phát
        if (rec.streams.every((s) => s.closed)) {
          this.stopForMember(app, roomId, rec.memberId).catch((e) =>
            app.log.error({ err: e, roomId, memberId: rec.memberId }, "recorder finalize failed")
          );
        }
      };
      producer.once("transportclose", onClosed);
      consumer.once("transportclose", onClosed);
      consumer.once("producerclose", onClosed);

      rec.streams.push(stream);
      app.log.info({ roomId, memberId: rec.memberId, kind: producer.kind, rtpPort }, "recorder stream opened");
      return stream;
    } catch (e) {
      app.log.error({ err: e, roomId, memberId: rec.memberId, kind: producer.kind }, "openStream failed");
      try {
        await transport?.close();
      } catch {}
      return null;
    }
  }

  private spawnFfmpeg(app: FastifyInstance, roomId: string, rec: MemberRecorder): void {
    if (!rec.streams.length || rec.ffmpeg) return;
    try {
      fs.writeFileSync(rec.sdpFile, buildSdp(rec.streams), "utf8");
    } catch (e) {
      app.log.error({ err: e }, "failed to write sdp");
      return;
    }

    const args = [
      "-hide_banner",
      // Debug (upload=false): bật info + -stats để stderr cho thấy ffmpeg nhận gói/bitrate hay không.
      "-loglevel", env.recording.upload ? "warning" : "info",
      "-protocol_whitelist", "file,udp,rtp",
      // Probe/analyze vừa phải: quá lớn làm demuxer trì hoãn đọc socket (mất gói đầu).
      "-analyzeduration", "1000000", "-probesize", "1000000",
      "-use_wallclock_as_timestamps", "1",
      "-f", "sdp", "-i", rec.sdpFile,
      // PHẢI transcode: nguồn VP8 không có SPS/PPS — `-c copy` vào mp4 chết "dimensions
      // not set" → file 0B (đã tái hiện đúng trên máy thật). Chuyển sang H264+AAC.
      "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-b:a", "96k",
      // Bắt buộc cho RTP live + wallclock timestamps: muxer mp4 phải đổi về gốc 0,
      // thiếu nó file chỉ ra 36B (moov rỗng) hoặc fail. (đã test trên máy thật)
      "-avoid_negative_ts", "make_zero",
      // QUAN TRỌNG: keyframe đầu ra đều đặn (1s) để muxer.frag flushes theo GOP —
      // thiếu nó, GOP đầu tiên bị giữ nguyên trong buffer tới khi có keyframe thứ 2;
      // broadcast ngắn không có → file ra chỉ ~32B (repro trên máy: 147 frame decode
      // nhưng file 36B; thêm -g 30 → 262KB). Không quá 1s mất dữ liệu kể cả bị terminate cứng.
      "-g", "30",
      "-movflags", "frag_keyframe+empty_moov",
      // Nhúng thông tin nguồn quay vào metadata file MP4 (đọc được bằng ffprobe)
      "-metadata", `session_id=${rec.sessionId ?? "none"}`,
      "-metadata", `device_id=${rec.deviceId}`,
      "-metadata", `device_type=${rec.deviceType}`,
      "-metadata", `phone_model=${rec.deviceModel || "unknown"}`,
      "-metadata", `camera_name=${rec.cameraName}`,
      "-y", rec.outFile,
    ];
    if (!env.recording.upload) args.splice(1, 0, "-stats");

    const proc = spawn(env.recording.ffmpegPath, args, {
      windowsHide: true,
      stdio: ["pipe", "ignore", "pipe"],
    });
    rec.ffmpeg = proc;

    proc.stderr.on("data", (chunk: Buffer) => {
      const line = chunk.toString().trim();
      if (line) {
        rec.stderrTail.push(line);
        if (rec.stderrTail.length > 60) rec.stderrTail.shift();
      }
    });
    proc.on("error", (err) => {
      app.log.error({ err, roomId, memberId: rec.memberId }, "ffmpeg spawn failed");
      rec.ffmpeg = null;
    });
    proc.on("exit", (code, signal) => {
      app.log.info({ code, signal, roomId, memberId: rec.memberId }, "ffmpeg exited");
      rec.ffmpeg = null;
    });

    app.log.info({ roomId, memberId: rec.memberId, args }, "ffmpeg started");
  }

  /** Dừng + finalize recorder của 1 member (gọi khi dừng phát / rời phòng). */
  public async stopForMember(app: FastifyInstance, roomId: string, memberId: string): Promise<void> {
    const roomRecorders = this.roomMap(roomId);
    const rec = roomRecorders.get(memberId);
    if (!rec || rec.stopping) return;
    rec.stopping = true;
    if (rec.startTimer) {
      clearTimeout(rec.startTimer);
      rec.startTimer = null;
    }
    if (rec.keyframeTimer) {
      clearInterval(rec.keyframeTimer);
      rec.keyframeTimer = null;
    }

    try {
      await this.gracefulFfmpegStop(rec);
      await this.finalize(app, roomId, rec);
    } catch (e) {
      app.log.error({ err: e, roomId, memberId }, "stopForMember failed");
    } finally {
      for (const s of rec.streams) await this.closeStream(s).catch(() => undefined);
      roomRecorders.delete(memberId);
      // Producer nào đến trong lúc đang stopping thì khởi động recorder mới ngay.
      this.drainPending(app, roomId, memberId);
    }
  }

  /** Khởi động lại recorder cho các producer bị xếp hàng trong lúc recorder cũ stopping. */
  private drainPending(app: FastifyInstance, roomId: string, memberId: string): void {
    const q = this.pending.get(memberId);
    if (!q) return;
    this.pending.delete(memberId);
    app.log.info({ roomId, memberId, count: q.producers.length }, "draining queued producers → restart recorder");
    for (const producer of q.producers) {
      this.start(q.app, q.roomMedia, q.roomId, q.memberId, producer).catch((e: unknown) =>
        q.app.log.error({ err: e, roomId, memberId }, "recorder restart from queue failed")
      );
    }
  }

  /** Dừng toàn bộ recorder của một room (gọi khi room đóng). */
  public stopRoom(app: FastifyInstance, roomId: string): void {
    const roomRecorders = this.map.get(roomId);
    if (!roomRecorders) return;
    for (const memberId of [...roomRecorders.keys()]) {
      this.stopForMember(app, roomId, memberId).catch(() => undefined);
    }
  }

  private async gracefulFfmpegStop(rec: MemberRecorder): Promise<void> {
    if (!rec.ffmpeg) return;
    const proc = rec.ffmpeg;
    await new Promise<void>((resolve) => {
      // Cho ffmpeg tới 15s để flush hết backlog (video dài/encoder bị nghẽn tích
      // GOP lớn) trước khi terminate cứng — 3s cũ quá ngắn, giết giữa flush làm
      // hỏng fragment cuối, file lên MinIO phát tới đuôi bị đứng hình/cắt.
      const hardKill = setTimeout(() => {
        try {
          proc.kill(); // Windows: TerminateProcess — an toàn nhờ frag mp4
        } catch {}
      }, 15000);
      proc.once("exit", () => {
        clearTimeout(hardKill);
        resolve();
      });
      // Windows không có SIGINT/SIGTERM thật — dừng ffmpeg đẹp bằng 'q' qua stdin
      try {
        proc.stdin?.write("q\n");
        proc.stdin?.end();
      } catch {
        try {
          proc.kill();
        } catch {}
      }
    });
  }

  private async closeStream(stream: StreamRec): Promise<void> {
    for (const fn of [
      () => stream.consumer?.close(),
      () => stream.transport?.close(),
    ]) {
      try {
        fn();
      } catch {}
    }
  }

  /**
   * Lấy số gói RTP cuối cùng của từng stream để chẩn đoán file rỗng/thiếu. packets=0
   * nghĩa là producer đó CHƯA TỪNG có media tới recorder (transport/ICE chưa nối
   * hoặc nguồn không produce) — đây là bằng chứng cho triệu chứng "quay nhiều máy
   * chỉ được N-1". Dùng ở finalize trước khi consumer bị đóng.
   */
  private async collectStreamStats(
    rec: MemberRecorder
  ): Promise<Array<{ kind: string; packets: number; closed: boolean }>> {
    const out: Array<{ kind: string; packets: number; closed: boolean }> = [];
    for (const s of rec.streams) {
      let packets = s.lastPktCount;
      try {
        if (!s.closed && !s.consumer.closed) {
          const stats = await s.consumer.getStats();
          const item = stats.find(
            (x) => (x as { rtpStream?: { packetCount?: number } }).rtpStream?.packetCount != null
          ) as { rtpStream?: { packetCount?: number } } | undefined;
          if (item?.rtpStream?.packetCount != null) packets = item.rtpStream.packetCount;
        }
      } catch {
        /* consumer đã đóng — dùng số đã đếm được */
      }
      out.push({ kind: s.kind, packets: typeof packets === "number" ? packets : -1, closed: s.closed });
    }
    return out;
  }

  private async finalize(app: FastifyInstance, roomId: string, rec: MemberRecorder): Promise<void> {
    const st = await fsp.stat(rec.outFile).catch(() => null);
    const streamStats = await this.collectStreamStats(rec);
    if (!st || st.size === 0) {
      // Giữ lại cả file rỗng + sdp để tra cứu (theo yêu cầu: không xoá gì trong data)
      app.log.warn(
        {
          roomId,
          memberId: rec.memberId,
          outFile: rec.outFile,
          sdpFile: rec.sdpFile,
          streams: streamStats,
          stderr: rec.stderrTail.join(" | "),
        },
        "recording empty, skip upload (file kept)"
      );
      return;
    }

    // File chỉ có header (ftyp ~32B, hoặc ftyp+empty moov ~1KB) là ffmpeg KHÔNG
    // decode được frame nào (thiếu keyframe / không có RTP video) — không phải video.
    // Trước đây chỉ check size === 0 nên các file này vẫn lên MinIO thành "video 1KB".
    if (st.size < env.recording.minBytes) {
      app.log.warn(
        {
          roomId,
          memberId: rec.memberId,
          outFile: rec.outFile,
          sdpFile: rec.sdpFile,
          sizeBytes: st.size,
          minBytes: env.recording.minBytes,
          streams: streamStats,
          stderr: rec.stderrTail.join(" | "),
        },
        "recording has no media frames (below min size), skip upload (file kept)"
      );
      return;
    }

    // Chế độ debug: giữ file local để soi trực tiếp, KHÔNG upload MinIO, KHÔNG insert videos
    if (!env.recording.upload) {
      app.log.warn(
        {
          roomId,
          memberId: rec.memberId,
          outFile: rec.outFile,
          sizeBytes: st.size,
          startedAt: rec.startedAt,
          stderrTail: rec.stderrTail,
        },
        "recording UPLOAD SKIPPED (SERVER_RECORDING_UPLOAD=false) — file kept for debug"
      );
      return;
    }

    const room = roomsRepo.findById(roomId);
    const member = roomMembersRepo.findById(rec.memberId);
    if (!room || !member) {
      app.log.warn({ roomId, memberId: rec.memberId }, "room/member gone, drop recording file");
      return;
    }

    const videoId = randomUUID();
    const sessionId = rec.sessionId ?? "nosession";
    // Cấu trúc MinIO: room_id / session_id_time_vn / device_id_brand_time.mp4
    // Folder lấy time từ recording_sessions.started_at (resolveSessionFolderName) để
    // khớp folder session.json — KHÔNG dùng rec.startedAt (lệch vài giây).
    const sessionFolder = resolveSessionFolderName(sessionId, rec.startedAt);
    const objectKey = buildVideoObjectKey(
      room.id,
      sessionFolder,
      rec.deviceId,
      rec.deviceModel,
      rec.startedAt,
      rec.deviceName
    );

    // duration_ms lấy từ media THẬT (ffprobe); fallback wallclock nếu ffprobe lỗi.
    const probedMs = await probeDurationMs(rec.outFile);
    const durationMs = probedMs ?? Math.max(500, Date.now() - rec.startedAt);

    // Upload NỀN — không chặn luồng dừng phát. `uploadAndIndex` tự có watchdog
    // timeout + retry cho từng lần fPutObject, nên không bao giờ treo vĩnh viễn.
    void this.uploadAndIndex(app, roomId, rec, videoId, objectKey, {
      ownerId: room.owner_id,
      deviceId: rec.deviceId,
      cameraName: rec.cameraName,
      durationMs,
      sizeBytes: st.size,
    }).catch((e) =>
      app.log.error({ err: e, roomId, memberId: rec.memberId }, "background upload crashed")
    );
  }

  /**
   * Đẩy file MP4 lên MinIO (watchdog 90s/lần + retry 3 lần), chỉ khi thành công
   * mới insert vào bảng videos. File LUÔN được giữ lại trong tmpDir
   * (./data/recordings-tmp) sau khi upload — kể cả thành công hay thất bại —
   * để tra cứu lại sau. Thất bại sau tất cả lượt: KHÔNG insert videos.
   */
  private async uploadAndIndex(
    app: FastifyInstance,
    roomId: string,
    rec: MemberRecorder,
    videoId: string,
    objectKey: string,
    meta: { ownerId: string; deviceId: string; cameraName: string; durationMs: number; sizeBytes: number }
  ): Promise<void> {
    const { memberId } = rec;
    let lastErr: unknown = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      const res = await withTimeout(
        app.minio.fPutObject(env.minio.bucket, objectKey, rec.outFile, {
          "Content-Type": "video/mp4",
          session_id: rec.sessionId ?? "nosession",
          device_id: rec.deviceId,
          device_type: String(rec.deviceType ?? 0),
          phone_model: rec.deviceModel || "unknown",
          camera_name: rec.cameraName,
          recorded_at: new Date(rec.startedAt).toISOString(),
        }),
        90_000
      );
      if (res.ok) {
        lastErr = null;
        break;
      }
      lastErr = res.error;
      app.log.error(
        { roomId, memberId, objectKey, attempt, size: meta.sizeBytes, err: lastErr },
        "minio fPutObject failed/stalled — retrying"
      );
      await new Promise((r) => setTimeout(r, 1500));
    }

    if (lastErr) {
      app.log.error(
        { roomId, memberId, objectKey, outFile: rec.outFile, size: meta.sizeBytes, err: lastErr },
        "minio upload FAILED after 3 attempts — files kept, videos row NOT inserted"
      );
      return;
    }

    videosRepo.insert({
      id: videoId,
      owner_id: meta.ownerId,
      device_id: meta.deviceId,
      session_id: rec.sessionId,
      local_video_uid: `server-recorder-${roomId.slice(0, 8)}-${rec.sessionId ?? "nosession"}-${rec.startedAt}`,
      camera_name: meta.cameraName,
      name: `Broadcast ${new Date(rec.startedAt).toISOString()}`,
      description: "Ghi tự động trên server khi phát sóng",
      object_key: objectKey,
      thumbnail_key: null,
      duration_ms: meta.durationMs,
      size_bytes: meta.sizeBytes,
      resolution: null,
      fps: null,
      codec: "opus/vp8-h264",
      checksum_sha256: "",
      recorded_at: new Date(rec.startedAt).toISOString(),
    });

    app.log.info(
      { roomId, memberId, videoId, objectKey, size: meta.sizeBytes, durationMs: meta.durationMs },
      "broadcast recording saved to MinIO"
    );

    // GIỮ LẠI tất cả file trong data/recordings-tmp theo yêu cầu (MP4 + SDP) —
    // không xoá gì sau khi upload. Muốn dọn thì xoá tay hoặc thêm job cleanup riêng.
    app.log.info(
      { roomId, memberId, outFile: rec.outFile, sdpFile: rec.sdpFile },
      "recording files kept in data folder (not deleted after upload)"
    );
  }
}

export const recorderService = new RecorderService();