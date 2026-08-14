import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

export function chunkPath(tmpDir: string, index: number): string {
  return path.join(tmpDir, `chunk_${index}.bin`);
}

export async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

export async function removeDir(dir: string): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true });
}

export function sha256OfBuffer(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

export async function sha256OfFile(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  const stream = createReadStream(filePath);
  await new Promise<void>((resolve, reject) => {
    stream.on("data", (chunk: string | Buffer) => {
      hash.update(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    });
    stream.on("end", () => resolve());
    stream.on("error", reject);
  });
  return hash.digest("hex");
}

/** Concatenates chunk_0..chunk_{n-1} (in that order) into a single file at destPath. */
export async function combineChunks(tmpDir: string, totalChunks: number, destPath: string): Promise<void> {
  const out = createWriteStream(destPath);
  const writeAndWait = (buf: Buffer) =>
    new Promise<void>((resolve, reject) => {
      out.write(buf, (err) => (err ? reject(err) : resolve()));
    });

  for (let i = 0; i < totalChunks; i++) {
    const buf = await fs.readFile(chunkPath(tmpDir, i));
    await writeAndWait(buf);
  }

  await new Promise<void>((resolve, reject) => {
    out.end((err: NodeJS.ErrnoException | null | undefined) => (err ? reject(err) : resolve()));
  });
}
