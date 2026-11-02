import { reactive } from "vue";
import { log } from "./log";

// Served by the API itself, so same-origin relative URLs work behind any proxy/TLS.
const BASE = "/it4788/api/v1";
const OK = 1000;
export const TOKEN_INVALID = 9998;

export interface Tokens {
  access_token: string;
  refresh_token: string;
}

export class ApiError extends Error {
  constructor(message: string, public code?: number) {
    super(message);
  }
}

export function errText(e: unknown): string {
  const err = e as { message?: string; code?: number };
  return (err?.message ?? String(e)) + (err?.code ? ` [${err.code}]` : "");
}

function stored<T>(key: string): T | null {
  try {
    return JSON.parse(localStorage.getItem(key) ?? "null");
  } catch {
    return null;
  }
}

export const session = reactive({
  tokens: stored<Tokens>("mc_tokens"),
  who: stored<{ phone: string; role: string }>("mc_user"),
});

export const deviceId = (() => {
  let id = localStorage.getItem("mc_device_id");
  if (!id) {
    id = "web_" + Math.random().toString(36).slice(2, 8);
    localStorage.setItem("mc_device_id", id);
  }
  return id;
})();

function setTokens(tokens: Tokens): void {
  session.tokens = tokens;
  localStorage.setItem("mc_tokens", JSON.stringify(tokens));
}

function clearSession(): void {
  session.tokens = null;
  session.who = null;
  localStorage.removeItem("mc_tokens");
  localStorage.removeItem("mc_user");
}

// One refresh at a time: parallel callers hitting 9998 together must not each spend the refresh token.
let refreshing: Promise<boolean> | null = null;

function refresh(): Promise<boolean> {
  refreshing ??= (async () => {
    log("access token hết hạn, đang refresh");
    const res = await fetch(BASE + "/auth/refresh", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refresh_token: session.tokens!.refresh_token }),
    });
    const j = await res.json().catch(() => ({}));
    if (j.code !== OK) return false;
    setTokens({ access_token: j.data.access_token, refresh_token: j.data.refresh_token ?? session.tokens!.refresh_token });
    return true;
  })().finally(() => {
    refreshing = null;
  });
  return refreshing;
}

export async function api<T = any>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const call = async () => {
    const res = await fetch(BASE + path, {
      method: init.method,
      headers: {
        ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...(session.tokens ? { Authorization: `Bearer ${session.tokens.access_token}` } : {}),
      },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    });
    return { res, j: await res.json().catch(() => ({})) };
  };

  let { res, j } = await call();
  if (j.code === TOKEN_INVALID && session.tokens) {
    if (await refresh()) {
      ({ res, j } = await call());
    } else {
      // Refresh token rejected too: the session is over, back to the login form.
      clearSession();
    }
  }
  if (j.code !== OK) throw new ApiError(j.message || `HTTP ${res.status}`, j.code);
  return j.data;
}

export async function login(phone: string, password: string): Promise<void> {
  const d = await api("/auth/login", {
    method: "POST",
    body: { phone, password, device_id: deviceId, device_type: 4, device_name: "Web Dashboard" },
  });
  session.who = { phone: d.user.phone, role: d.account_role };
  localStorage.setItem("mc_user", JSON.stringify(session.who));
  setTokens({ access_token: d.access_token, refresh_token: d.refresh_token });
  log(`login ok ${d.account_role}`);
}

export async function logout(): Promise<void> {
  try {
    await api("/auth/logout", { method: "POST" });
  } catch {
    /* token may already be dead; the local session goes either way */
  }
  clearSession();
}
