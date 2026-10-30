#!/usr/bin/env bun
// Restore drill / restore preparation: downloads a snapshot from the backup bucket (latest by
// default), verifies it (integrity_check + row counts), and leaves the database file on disk.
// Putting it back into production is a deliberate manual step — see docs/RUNBOOK.md "Restore".
//
// Usage: bun scripts/restore.ts [snapshot-key] [--out restored.sqlite]

import { parseArgs } from "node:util";
import { loadConfig } from "../src/config";
import { restoreSnapshot } from "../src/ops/backup";
import { s3Store } from "../src/ops/s3";

const { values, positionals } = parseArgs({ allowPositionals: true, options: { out: { type: "string", default: "restored.sqlite" } } });
const cfg = loadConfig();
if (!cfg.BACKUP_BUCKET || !cfg.BACKUP_ENDPOINT || !cfg.BACKUP_ACCESS_KEY_ID || !cfg.BACKUP_SECRET_ACCESS_KEY) {
  console.error("BACKUP_BUCKET, BACKUP_ENDPOINT, BACKUP_ACCESS_KEY_ID and BACKUP_SECRET_ACCESS_KEY are required");
  process.exit(1);
}
const store = s3Store({ bucket: cfg.BACKUP_BUCKET, endpoint: cfg.BACKUP_ENDPOINT, region: cfg.BACKUP_REGION, accessKeyId: cfg.BACKUP_ACCESS_KEY_ID, secretAccessKey: cfg.BACKUP_SECRET_ACCESS_KEY, virtualHostedStyle: cfg.BACKUP_VIRTUAL_HOSTED === "true" });
const objects = (await store.list("backups/")).sort((a, b) => b.key.localeCompare(a.key));
console.log(`${objects.length} snapshot(s) in ${cfg.BACKUP_BUCKET}; newest: ${objects[0]?.key ?? "none"}`);
const r = await restoreSnapshot(store, values.out!, positionals[0]);
console.log(JSON.stringify({ restored: r.key, to: values.out, integrity: r.integrity, quotes: r.quotes, applications: r.applications }));
process.exit(r.integrity === "ok" ? 0 : 1);
