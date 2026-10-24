// Upload benchmark. Not part of the build. Usage:
//   npx tsx scripts/bench-upload.ts [sizeMB=100] [baseUrl=http://localhost:3000]
// Logs in as a seeded remote account, uploads a random N MB "mp4", and prints
// time per stage. Works against both the old chunk protocol (init returns
// chunk_size) and the presigned PUT protocol (init returns upload_url).
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const sizeMb = Number(process.argv[2] ?? 100);
const base = (process.argv[3] ?? "http://localhost:3000") + "/it4788/api/v1";
const email = process.env.BENCH_EMAIL ?? "remote1@multicam.local";
const password = process.env.BENCH_PASSWORD ?? "Remote@123";

async function api(method: string, url: string, token: string | null, body?: unknown) {
  const res = await fetch(base + url, {
    method,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await res.json()) as { code: number; message: string; data: any };
  if (json.code !== 1000) throw new Error(`${method} ${url} -> ${res.status} ${json.code} ${json.message}`);
  return json.data;
}

async function main() {
  const file = path.join(os.tmpdir(), `bench-${randomUUID()}.mp4`);
  await writeFile(file, randomBytes(sizeMb * 1024 * 1024));
  const deviceId = `bench-${randomUUID()}`;
  const times: Record<string, number> = {};
  const stage = async <T>(name: string, fn: () => Promise<T>) => {
    const t = performance.now();
    const r = await fn();
    times[name] = Math.round(performance.now() - t);
    return r;
  };
  try {
    const login = await api("POST", "/auth/login", null, {
      email, password, device_id: deviceId, device_type: 1, device_name: "bench",
    });
    const token: string = login.access_token;
    const buf = await stage("read+sha256", async () => {
      const b = await readFile(file);
      return { b, sha: createHash("sha256").update(b).digest("hex") };
    });
    const init = await stage("init", () =>
      api("POST", "/videos/uploads", token, {
        file_name: path.basename(file),
        file_size: buf.b.length,
        mime_type: "video/mp4",
        checksum_sha256: buf.sha,
        metadata: { local_video_uid: randomUUID(), device_id: deviceId },
      })
    );
    if (init.upload_url) {
      await stage("put", async () => {
        const res = await fetch(init.upload_url, { method: "PUT", body: buf.b });
        if (!res.ok) throw new Error(`PUT ${res.status} ${await res.text()}`);
      });
    } else {
      await stage("chunks", async () => {
        for (let i = 0; i < init.total_chunks; i++) {
          const res = await fetch(`${base}/videos/uploads/${init.upload_id}/chunks/${i}`, {
            method: "PUT",
            headers: { "content-type": "application/octet-stream", authorization: `Bearer ${token}` },
            body: buf.b.subarray(i * init.chunk_size, (i + 1) * init.chunk_size),
          });
          if (!res.ok) throw new Error(`chunk ${i} -> ${res.status} ${await res.text()}`);
        }
      });
    }
    await stage("complete", () => api("POST", `/videos/uploads/${init.upload_id}/complete`, token, {}));
    const total = Object.values(times).reduce((a, b) => a + b, 0);
    console.log(JSON.stringify({ sizeMb, protocol: init.upload_url ? "presigned" : "chunks", ms: times, totalMs: total }));
  } finally {
    await rm(file, { force: true });
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
