import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Disaster recovery: a consistent snapshot of the live SQLite database (VACUUM INTO, safe while the
// app is serving), integrity-checked, gzipped, and stored off-box in an S3-compatible bucket.
// Restore drills download a snapshot and verify it opens, passes integrity_check, and has rows.

export interface BackupObject {
  key: string;
  lastModified: Date;
  size: number;
}

export interface BackupStore {
  put(key: string, data: Uint8Array): Promise<void>;
  get(key: string): Promise<Uint8Array>;
  list(prefix: string): Promise<BackupObject[]>;
  delete(key: string): Promise<void>;
}

/** Local-directory store for tests and drills. */
export function fsStore(dir: string): BackupStore {
  return {
    put: async (key, data) => {
      await Bun.write(join(dir, key), data);
    },
    get: async (key) => new Uint8Array(await Bun.file(join(dir, key)).arrayBuffer()),
    list: async (prefix) => {
      const glob = new Bun.Glob(`${prefix}**`);
      const out: BackupObject[] = [];
      for await (const key of glob.scan({ cwd: dir })) {
        const f = Bun.file(join(dir, key));
        out.push({ key, lastModified: new Date(f.lastModified), size: f.size });
      }
      return out;
    },
    delete: async (key) => {
      rmSync(join(dir, key), { force: true });
    },
  };
}

export interface SnapshotReport {
  integrity: string;
  quotes: number;
  applications: number;
}

export function inspectSnapshot(path: string): SnapshotReport {
  const db = new Database(path, { readonly: true });
  try {
    const integrity = db.query<{ integrity_check: string }, []>("PRAGMA integrity_check").get()!.integrity_check;
    const quotes = db.query<{ n: number }, []>("SELECT COUNT(*) n FROM quotes").get()!.n;
    const applications = db.query<{ n: number }, []>("SELECT COUNT(*) n FROM applications").get()!.n;
    return { integrity, quotes, applications };
  } finally {
    db.close();
  }
}

export interface BackupResult extends SnapshotReport {
  key: string;
  bytes: number;
  pruned: string[];
}

export async function createBackup(db: Database, store: BackupStore, now: Date, retentionDays: number): Promise<BackupResult> {
  const dir = mkdtempSync(join(tmpdir(), "quote-backup-"));
  const path = join(dir, "snapshot.sqlite");
  try {
    db.exec(`VACUUM INTO '${path.replaceAll("'", "''")}'`);
    const report = inspectSnapshot(path);
    if (report.integrity !== "ok") throw new Error(`snapshot failed integrity_check: ${report.integrity}`);
    const gz = Bun.gzipSync(new Uint8Array(await Bun.file(path).arrayBuffer()));
    const key = `backups/quotes-${now.toISOString().replace(/[:.]/g, "-")}.sqlite.gz`;
    await store.put(key, gz);
    const cutoff = now.getTime() - retentionDays * 86400_000;
    const pruned: string[] = [];
    for (const o of await store.list("backups/")) {
      if (o.key !== key && o.lastModified.getTime() < cutoff) {
        await store.delete(o.key);
        pruned.push(o.key);
      }
    }
    return { ...report, key, bytes: gz.length, pruned };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Downloads a snapshot (latest if no key), writes it to `outPath`, and verifies it. */
export async function restoreSnapshot(store: BackupStore, outPath: string, key?: string): Promise<SnapshotReport & { key: string }> {
  const objects = (await store.list("backups/")).sort((a, b) => b.key.localeCompare(a.key));
  const target = key ?? objects[0]?.key;
  if (!target) throw new Error("no backups found");
  const raw = Bun.gunzipSync(new Uint8Array(await store.get(target)) as Uint8Array<ArrayBuffer>);
  await Bun.write(outPath, raw);
  return { key: target, ...inspectSnapshot(outPath) };
}
