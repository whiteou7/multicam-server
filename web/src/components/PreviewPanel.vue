<script setup lang="ts">
import { computed } from "vue";
import type { PreviewSnapshot } from "../preview";
import { HEALTH_LABEL } from "../labels";
import { tileHealth } from "../preview";

const props = defineProps<{ snap: PreviewSnapshot; enabled: boolean }>();
defineEmits<{ start: []; stop: [] }>();

const status = computed(() => {
  const { state, error, tiles } = props.snap;
  if (state === "connecting") return "Đang kết nối...";
  if (state === "reconnecting") return "Mất kết nối, đang thử lại...";
  if (state === "failed") return error;
  if (state === "live") return tiles.length ? `Đang xem ${tiles.length} luồng` : "Đang chờ remote phát sóng";
  return "";
});

function fullscreen(e: MouseEvent) {
  const el = e.currentTarget as HTMLElement;
  if (document.fullscreenElement) void document.exitFullscreen();
  else void el.requestFullscreen().catch(() => undefined);
}

function play(e: Event) {
  void (e.target as HTMLVideoElement).play().catch(() => undefined);
}
</script>

<template>
  <section>
    <h2>Xem trực tiếp</h2>
    <div class="row">
      <button v-if="snap.state === 'idle' || snap.state === 'failed'" class="primary" :disabled="!enabled" @click="$emit('start')">
        Bật preview
      </button>
      <button v-else @click="$emit('stop')">Tắt preview</button>
      <span :class="snap.state === 'failed' ? 'bad' : 'muted'">{{ status }}</span>
    </div>
    <div class="tiles">
      <figure v-for="t in snap.tiles" :key="t.memberId" class="tile" @click="fullscreen">
        <figcaption>
          <span>
            <strong>{{ t.camera_name || "?" }}</strong>
            <span class="muted"> {{ [t.device_name, t.device_model].filter(Boolean).join(" · ") }}</span>
            <span class="mono muted"> {{ t.device_short_id || t.memberId.slice(0, 8) }}</span>
          </span>
          <span :class="tileHealth(t) === 'live' ? 'accent' : 'bad'">{{ HEALTH_LABEL[tileHealth(t)] }}</span>
        </figcaption>
        <video :srcObject="t.stream" autoplay muted playsinline @loadedmetadata="play" />
      </figure>
    </div>
  </section>
</template>
