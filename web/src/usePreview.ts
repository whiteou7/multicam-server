import { onScopeDispose, shallowRef, watch, type Ref } from "vue";
import { api, session } from "./api";
import { log } from "./log";
import { Preview, type PreviewSnapshot } from "./preview";

const IDLE: PreviewSnapshot = { state: "idle", error: null, tiles: [] };

export function usePreview(roomId: Ref<string | null>) {
  // Snapshots are replaced wholesale and hold MediaStreams, so no deep reactivity.
  const snap = shallowRef<PreviewSnapshot>(IDLE);
  let preview: Preview | null = null;

  function stop(): void {
    preview?.dispose();
    preview = null;
    snap.value = IDLE;
  }

  function start(): void {
    if (!roomId.value) return;
    stop();
    preview = new Preview({
      roomId: roomId.value,
      api,
      accessToken: () => session.tokens?.access_token,
      log,
      onChange: (s) => (snap.value = s),
    });
    preview.start();
  }

  watch(roomId, stop);
  onScopeDispose(stop);

  return { snap, start, stop };
}
