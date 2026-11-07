// Shared response cache for the big read-only JSON endpoints
// (/api/entities, /api/flows). Tables only change when an ingest pipeline
// runs (separate process), so one response serves every visitor instead of
// one Prisma fetch + stringify per request. In-flight dedup means ten
// simultaneous first loads run ONE query, not ten. New data appears at
// latest TTL after an ingest; restarting clears it. Size guard: arbitrary
// ?limit= values can't grow the caches without bound.
//
// Two variants: cachedBody keeps small bodies as strings in memory;
// cachedStream writes big arrays to disk once per TTL and serves them with
// sendFile, so neither the heap (no giant string, no string-cache copy)
// nor Neon (one scan per TTL) pays per request.
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const responseCache = new Map<string, { at: number; body: string }>();
const inflightBuilds = new Map<string, Promise<string>>();

// File-backed stream cache: key -> absolute .json path in the OS tmp dir
// (ephemeral like memory on Render — restarts clear it, requests don't).
const streamDir = path.join(os.tmpdir(), "whofundsit-resp");
const streamFiles = new Map<string, string>();
const inflightStreams = new Map<string, Promise<string>>();
const MAX_STREAM_FILES = 20;

function streamPath(key: string): string {
  return path.join(
    streamDir,
    `${createHash("sha1").update(key).digest("hex")}.json`,
  );
}

export function clearResponseCache(): void {
  responseCache.clear();
  inflightBuilds.clear();
  for (const file of streamFiles.values()) {
    fs.promises.unlink(file).catch(() => {});
  }
  streamFiles.clear();
  inflightStreams.clear();
}

export async function cachedBody(
  key: string,
  ttlMs: number,
  build: () => Promise<unknown>,
): Promise<string> {
  const hit = responseCache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) {
    return hit.body;
  }
  const running = inflightBuilds.get(key);
  if (running) {
    return running;
  }
  const run = (async () => {
    try {
      const body = JSON.stringify(await build());
      if (responseCache.size > 50) {
        responseCache.clear();
      }
      responseCache.set(key, { at: Date.now(), body });
      return body;
    } finally {
      inflightBuilds.delete(key);
    }
  })();
  inflightBuilds.set(key, run);
  return run;
}

// Build a big JSON array once per TTL and return its file path for
// sendFile. The builder emits rows in final order; chunked stringify
// joined with commas is byte-identical to stringifying the whole array,
// so the wire format is unchanged (plain JSON array, still gzip-friendly).
// Failures delete the partial file and are never cached.
export async function cachedStream(
  key: string,
  ttlMs: number,
  build: (emit: (row: unknown) => Promise<void>) => Promise<void>,
): Promise<string> {
  const known = streamFiles.get(key);
  if (known) {
    try {
      if (Date.now() - fs.statSync(known).mtimeMs < ttlMs) {
        return known;
      }
    } catch {
      streamFiles.delete(key);
    }
  }
  const running = inflightStreams.get(key);
  if (running) {
    return running;
  }
  const run = (async () => {
    fs.mkdirSync(streamDir, { recursive: true });
    const file = streamPath(key);
    const tmp = `${file}.${process.pid}.tmp`;
    const out = fs.createWriteStream(tmp);
    let streamErr: Error | null = null;
    out.on("error", (err) => {
      streamErr = err;
    });
    let first = true;
    const emit = async (row: unknown): Promise<void> => {
      const chunk = (first ? "[" : ",") + JSON.stringify(row);
      first = false;
      if (!out.write(chunk)) {
        await new Promise<void>((resolve) => out.once("drain", resolve));
      }
    };
    try {
      await build(emit);
      if (streamErr) {
        throw streamErr;
      }
      out.write(first ? "[]" : "]");
      await new Promise<void>((resolve) => out.end(resolve));
      if (streamErr) {
        throw streamErr;
      }
      fs.renameSync(tmp, file);
      streamFiles.set(key, file);
      while (streamFiles.size > MAX_STREAM_FILES) {
        const oldestKey = streamFiles.keys().next();
        if (oldestKey.done) {
          break;
        }
        const oldestFile = streamFiles.get(oldestKey.value);
        streamFiles.delete(oldestKey.value);
        if (oldestFile && oldestFile !== file) {
          await fs.promises.unlink(oldestFile).catch(() => {});
        }
      }
      return file;
    } catch (err) {
      out.destroy();
      await fs.promises.unlink(tmp).catch(() => {});
      throw err;
    } finally {
      inflightStreams.delete(key);
    }
  })();
  inflightStreams.set(key, run);
  return run;
}
