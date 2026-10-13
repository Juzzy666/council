/**
 * Publishing the sweep report to Vercel Blob, so a status page can read it.
 *
 * The request shape is copied from the upload this account already runs in
 * production (`thelab-violations` → `blob.vercel-storage.com`), rather than
 * invented: same API version header, same overwrite and no-random-suffix flags,
 * so the object lands at a stable, cacheable path a static page can fetch.
 */

import { readFile } from "node:fs/promises";
import type { Fetcher } from "./github.js";

export interface PublishConfig {
  /** Object path inside the blob store, e.g. `council/sweep.json`. */
  readonly blobPath?: string;
  /** `max-age` for the object, in seconds. Short, because this is a status file. */
  readonly cacheMaxAge?: number;
}

export interface PublishOptions {
  readonly token: string;
  readonly path: string;
  readonly cacheMaxAge?: number;
  readonly fetcher?: Fetcher;
}

export interface PublishResult {
  readonly ok: boolean;
  readonly url?: string;
  readonly error?: string;
}

export function blobTokenFromEnv(env: NodeJS.ProcessEnv = process.env): string | null {
  return (
    env["COUNCIL_BLOB_TOKEN"] ??
    env["BLOB_READ_WRITE_TOKEN"] ??
    env["LAB_BLOB_TOKEN"] ??
    null
  );
}

/** Upload a JSON payload. Never throws: publishing is reporting, not the work. */
export async function publishJson(payload: unknown, options: PublishOptions): Promise<PublishResult> {
  const fetcher = options.fetcher ?? ((url, init) => fetch(url, init));
  const path = options.path.replace(/^\/+/, "");
  try {
    const response = await fetcher(`https://blob.vercel-storage.com/${path}`, {
      method: "PUT",
      headers: {
        authorization: `Bearer ${options.token}`,
        "x-api-version": "7",
        "content-type": "application/json",
        "x-add-random-suffix": "0",
        "x-allow-overwrite": "1",
        "x-cache-control-max-age": String(options.cacheMaxAge ?? 60),
      },
      body: JSON.stringify(payload),
    });
    const text = await response.text();
    if (!response.ok) return { ok: false, error: `${response.status}: ${text.slice(0, 200)}` };
    const body = text ? (JSON.parse(text) as { url?: string }) : {};
    return { ok: true, ...(body.url ? { url: body.url } : {}) };
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
}

export async function publishFile(file: string, options: PublishOptions): Promise<PublishResult> {
  try {
    return await publishJson(JSON.parse(await readFile(file, "utf8")), options);
  } catch (error) {
    return { ok: false, error: `cannot read ${file}: ${(error as Error).message}` };
  }
}
