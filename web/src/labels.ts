import type { Health } from "./preview";

export const HEALTH_LABEL: Record<Health, string> = {
  live: "đang phát",
  stalled: "đứng hình",
  lost: "mất tín hiệu",
};
