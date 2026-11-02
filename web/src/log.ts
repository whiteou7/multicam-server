import { ref } from "vue";

const MAX_LINES = 300;

export const logLines = ref<string[]>([]);

export function log(msg: string): void {
  logLines.value.push(`${new Date().toLocaleTimeString()} ${msg}`);
  if (logLines.value.length > MAX_LINES) logLines.value.splice(0, logLines.value.length - MAX_LINES);
}
