import type { BackupObject, BackupStore } from "./backup";

// Thin adapter over Bun's native S3 client. Excluded from the unit-coverage gate (it is network glue);
// verified instead by a live probe against the real bucket (put/list/get/delete) and by restore drills.
// Railway buckets require path-style URLs: virtual-host style returns AccessDenied (probed 2026-10-15).

/** S3-compatible store (Railway buckets) on Bun's native S3 client. */
export function s3Store(cfg: { bucket: string; endpoint: string; region: string; accessKeyId: string; secretAccessKey: string; virtualHostedStyle?: boolean }): BackupStore {
  const client = new Bun.S3Client({
    bucket: cfg.bucket,
    endpoint: cfg.endpoint,
    region: cfg.region,
    accessKeyId: cfg.accessKeyId,
    secretAccessKey: cfg.secretAccessKey,
    virtualHostedStyle: cfg.virtualHostedStyle ?? false,
  });
  return {
    put: async (key, data) => {
      await client.write(key, data, { type: "application/gzip" });
    },
    get: async (key) => new Uint8Array(await client.file(key).arrayBuffer()),
    list: async (prefix) => {
      const out: BackupObject[] = [];
      let token: string | undefined;
      do {
        const page = await client.list({ prefix, continuationToken: token });
        for (const o of page.contents ?? []) out.push({ key: o.key, lastModified: new Date(o.lastModified ?? 0), size: o.size ?? 0 });
        token = page.isTruncated ? page.nextContinuationToken : undefined;
      } while (token);
      return out;
    },
    delete: async (key) => {
      await client.delete(key);
    },
  };
}

