import { log } from "./log";

// Nhạc nền phát trên máy Controller trong lúc ghi hình.
// File đặt ở web/public/music/record.m4a → build ra public/music/record.m4a,
// thay file đó trên server là đổi nhạc, không cần build lại.
// Lưu ý: public/ bị gitignore (file ~69MB). Trên VPS: chép vào ./music cạnh
// docker-compose.yml, compose mount thư mục đó vào /app/public/music.
const SRC = `${import.meta.env.BASE_URL}music/record.m4a`;

let audio: HTMLAudioElement | null = null;
let unlocked = false;
let wantPlaying = false;

function el(): HTMLAudioElement {
  if (!audio) {
    audio = new Audio(SRC);
    audio.loop = true; // hết bài → tự quay về đầu
    audio.preload = "auto";
  }
  return audio;
}

/**
 * Gọi đồng bộ ngay trong click handler, TRƯỚC mọi await: Safari chỉ cho play()
 * khi còn trong user gesture, mà play() thật chạy sau khi API start trả về.
 */
export function unlockMusic(): void {
  if (unlocked) return;
  const a = el();
  if (!a.paused) return;
  a.muted = true;
  a.play()
    .then(() => {
      unlocked = true;
      // playMusic() có thể đã được gọi trong lúc chờ — khi đó để nó phát tiếp.
      if (!wantPlaying) a.pause();
    })
    .catch(() => {})
    .finally(() => {
      a.muted = false;
    });
}

/** Phát tiếp từ vị trí đang dừng (lần đầu là từ 0). Đang phát thì giữ nguyên. */
export function playMusic(): void {
  wantPlaying = true;
  const a = el();
  a.muted = false;
  if (!a.paused) return;
  a.play().catch((e) => log(`không phát được nhạc: ${e instanceof Error ? e.message : e}`));
}

/**
 * Đưa nhạc về đầu bài (cho người thử tiếp theo). Đang phát thì phát lại từ đầu,
 * đang dừng thì lần "Ghi tất cả" sau sẽ bắt đầu từ đầu.
 */
export function resetMusic(): void {
  if (audio) audio.currentTime = 0;
  log("nhạc: về đầu bài");
}

/** Dừng đúng tại thời điểm hiện tại, giữ vị trí cho lần ghi sau. */
export function pauseMusic(): void {
  wantPlaying = false;
  audio?.pause();
}
