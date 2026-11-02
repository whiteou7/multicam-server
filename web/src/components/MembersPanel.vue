<script setup lang="ts">
import type { PreviewSnapshot } from "../preview";
import { HEALTH_LABEL } from "../labels";
import { tileHealth } from "../preview";
import type { Member, Room } from "../useRoom";

const props = defineProps<{ room: Room; snap: PreviewSnapshot }>();

const REC: Record<string, string> = {
  idle: "nghỉ",
  accepted: "đã nhận lệnh",
  recording: "đang ghi",
  saved: "đã lưu",
  failed: "lỗi",
};
const UPLOAD: Record<string, string> = { uploaded: "đã tải lên", failed: "lỗi" };

// Online/recording come from room sync, the stream column from the preview; both meet here.
function stream(m: Member): { text: string; bad: boolean } {
  if (props.snap.state !== "live") return { text: "-", bad: false };
  const tile = props.snap.tiles.find((t) => t.memberId === m.member_id);
  if (!tile) return { text: "không phát", bad: false };
  const h = tileHealth(tile);
  return { text: HEALTH_LABEL[h], bad: h !== "live" };
}

function upload(m: Member): string {
  if (m.upload_state === "uploading") return `đang tải lên ${m.upload_percent ?? 0}%`;
  return UPLOAD[m.upload_state ?? ""] ?? "-";
}
</script>

<template>
  <section>
    <h2>Thành viên <span class="muted">rev {{ room.revision }}</span></h2>
    <div class="scroll">
      <table v-if="room.members.length">
        <thead>
          <tr><th>Camera</th><th>Thiết bị</th><th>Kết nối</th><th>Luồng</th><th>Ghi</th><th>Tải lên</th><th></th></tr>
        </thead>
        <tbody>
          <tr v-for="m in room.members" :key="m.member_id">
            <td>{{ m.camera_name || "?" }}</td>
            <td>
              {{ [m.device_name, m.device_model].filter(Boolean).join(" · ") || "?" }}
              <span class="mono muted">{{ m.device_short_id || m.device_id.slice(0, 8) }}</span>
            </td>
            <td :class="{ muted: !m.is_online }">{{ m.is_online ? "online" : "offline" }}</td>
            <td :class="{ bad: stream(m).bad }">{{ stream(m).text }}</td>
            <td :class="{ accent: m.recording_state === 'recording', bad: m.recording_state === 'failed' }">
              {{ REC[m.recording_state] ?? m.recording_state }}
            </td>
            <td>{{ upload(m) }}</td>
            <td class="actions"><button class="small" @click="room.flash(m.member_id)">flash</button></td>
          </tr>
        </tbody>
      </table>
      <p v-else class="muted">{{ room.roomId ? "Chưa có thành viên." : "Chưa chọn phòng." }}</p>
    </div>
    <div class="row">
      <button class="danger" :disabled="!room.roomId" @click="room.startRecording">Ghi tất cả</button>
      <button :disabled="!room.roomId" @click="room.stopRecording">Dừng tất cả</button>
    </div>
    <p v-if="room.recNotice" class="muted">{{ room.recNotice }}</p>
  </section>
</template>
