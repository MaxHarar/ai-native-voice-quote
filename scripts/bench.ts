#!/usr/bin/env bun
// Tool latency bench: N full quote flows against a running server; reports p50/p95 per tool.
// Uses year/make/model (no VIN) so NHTSA latency is excluded. Usage: bun scripts/bench.ts [baseUrl] [flows]

export {};

const base = process.argv[2] ?? `http://127.0.0.1:${process.env.PORT ?? 3000}`;
const flows = Number(process.argv[3] ?? 40);
const secret = process.env.TOOL_SECRET!;
const samples: Record<string, number[]> = {};

async function call(tool: string, body: Record<string, unknown>) {
  const t0 = performance.now();
  const res = await fetch(`${base}/tools/${tool}`, { method: "POST", headers: { "content-type": "application/json", "x-tool-secret": secret }, body: JSON.stringify(body) });
  const json = (await res.json()) as any;
  (samples[tool] ??= []).push(performance.now() - t0);
  if (!json.ok) throw new Error(`${tool}: ${json.error}`);
  return json;
}

for (let i = 0; i < flows; i++) {
  const C = { conversation_id: `bench_${Date.now()}_${i}`, eval_tag: "bench" };
  await call("start_quote", { ...C, caller_name: "Bench Tester", zip: "08540", prior_insurance_months: 24 });
  await call("save_driver", { ...C, driver_index: 1, first_name: "Bench", last_name: "Smith", date_of_birth: "1985-06-01", license_state: "NJ", license_number: "S10000000000001", years_licensed: 18, tickets_3y: 0, at_fault_accidents_3y: 0, dui_3y: false });
  await call("save_vehicle", { ...C, vehicle_index: 1, year: 2020, make: "Toyota", model: "Camry", usage: "commute", annual_miles: 12000 });
  await call("set_coverage", { ...C, package: "recommended", pay_in_full: false });
  const q = await call("get_quote", C);
  await call("submit_application", { ...C, quote_hash: q.quote_hash, caller_confirmed: true, first_name: "Bench", last_name: "Smith" });
}

const pct = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(p * xs.length))]!;
const all = Object.values(samples).flat();
const rows = Object.entries(samples).map(([tool, xs]) => ({ tool, n: xs.length, p50: +pct(xs, 0.5).toFixed(1), p95: +pct(xs, 0.95).toFixed(1) }));
rows.push({ tool: "ALL", n: all.length, p50: +pct(all, 0.5).toFixed(1), p95: +pct(all, 0.95).toFixed(1) });
console.table(rows);
const p95 = pct(all, 0.95);
console.log(JSON.stringify({ base, flows, p95_ms: +p95.toFixed(1), budget_ms: 300, pass: p95 < 300 }));
process.exit(p95 < 300 ? 0 : 1);
