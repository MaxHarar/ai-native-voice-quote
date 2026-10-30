#!/usr/bin/env bun
// Load test (run once per capacity question, not every release): boots the real server and drives
// C concurrent workers through N complete quote flows (start → driver → vehicle → coverage → quote
// → submit). Reports per-tool p50/p95/p99, errors, throughput, and data integrity (every flow must
// produce exactly one unique application number).
//
// Usage: bun scripts/load.ts [concurrency=25] [flows=200]

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const concurrency = Number(process.argv[2] ?? 25);
const flows = Number(process.argv[3] ?? 200);
const port = 4000 + Math.floor(Math.random() * 1000);
const dir = mkdtempSync(join(tmpdir(), "quote-load-"));
const SECRET = "load-tool-secret-load-tool-secret";
const base = `http://127.0.0.1:${port}`;

const server = Bun.spawn(["bun", join(new URL("..", import.meta.url).pathname, "src/index.ts")], {
  cwd: dir, // no .env here: the load-test server never sees real secrets
  env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", TOOL_SECRET: SECRET, PORT: String(port), DATABASE_PATH: join(dir, "load.sqlite"), ALERTS_DISABLED: "1", VPIC_TIMEOUT_MS: "1", NODE_ENV: "development" },
  stdout: "ignore",
  stderr: "inherit",
});
for (let i = 0; i < 50; i++) {
  try {
    if ((await fetch(`${base}/health`)).ok) break;
  } catch {}
  await Bun.sleep(100);
}

const samples: Record<string, number[]> = {};
const errors: string[] = [];
const apps = new Set<string>();

async function call(tool: string, body: Record<string, unknown>) {
  const t0 = performance.now();
  const res = await fetch(`${base}/tools/${tool}`, { method: "POST", headers: { "content-type": "application/json", "x-tool-secret": SECRET }, body: JSON.stringify(body) });
  const json = (await res.json()) as Record<string, any>;
  (samples[tool] ??= []).push(performance.now() - t0);
  if (!json.ok) errors.push(`${tool}:${json.error}`);
  return json;
}

async function flow(i: number) {
  const pa = i % 3 === 0;
  const C = { conversation_id: `conv_load_${i}` };
  await call("start_quote", { ...C, caller_name: `Load Tester ${i}`, zip: pa ? "19123" : "08540", prior_insurance_months: 24 });
  await call("save_driver", {
    ...C, driver_index: 1, first_name: "Load", last_name: pa ? "Tester" : "Tester", date_of_birth: "1985-06-01", license_state: pa ? "PA" : "NJ",
    license_number: pa ? `${String(10000000 + i).slice(0, 8)}` : `T${String(10000000000000 + i).padStart(14, "0")}`, years_licensed: 18, tickets_3y: i % 5 === 0 ? 1 : 0, at_fault_accidents_3y: 0, dui_3y: false,
  });
  await call("save_vehicle", { ...C, vehicle_index: 1, year: 2015 + (i % 10), make: "Toyota", model: "Camry", usage: "commute", annual_miles: 12000 });
  await call("set_coverage", { ...C, package: (["minimum", "recommended", "premium"] as const)[i % 3], pay_in_full: i % 2 === 0, ...(pa ? { tort_option: i % 2 ? "limited" : "full" } : {}) });
  const q = await call("get_quote", C);
  const s = await call("submit_application", { ...C, quote_hash: q.quote_hash, caller_confirmed: true, first_name: "Load", last_name: "Tester" });
  if (s.application_number) apps.add(s.application_number);
}

const t0 = performance.now();
let next = 0;
await Promise.all(
  Array.from({ length: concurrency }, async () => {
    while (next < flows) await flow(next++);
  }),
);
const elapsed = (performance.now() - t0) / 1000;
server.kill("SIGTERM");
await server.exited;
rmSync(dir, { recursive: true, force: true });

const pct = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(p * xs.length))]!;
const all = Object.values(samples).flat();
console.table(
  [...Object.entries(samples), ["ALL", all] as const].map(([tool, xs]) => ({ tool, n: xs.length, p50: +pct(xs, 0.5).toFixed(1), p95: +pct(xs, 0.95).toFixed(1), p99: +pct(xs, 0.99).toFixed(1) })),
);
const result = {
  concurrency,
  flows,
  requests: all.length,
  seconds: +elapsed.toFixed(2),
  requestsPerSecond: +(all.length / elapsed).toFixed(0),
  p95Ms: +pct(all, 0.95).toFixed(1),
  p99Ms: +pct(all, 0.99).toFixed(1),
  errors: errors.length,
  uniqueApplications: apps.size,
  integrity: apps.size === flows && errors.length === 0,
};
console.log(JSON.stringify(result));
process.exit(result.integrity && result.p95Ms < 300 ? 0 : 1);
