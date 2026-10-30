#!/usr/bin/env bun
// Black-box smoke test: boots the REAL server process (Bun.serve over a socket, temp DB, test
// secrets) and probes it from outside: content types, auth, hiding, full NJ and PA quote flows,
// the quote summary page, and PII in logs. In-process tests can't see socket-level bugs (the
// octet-stream root-URL bug only reproduced over a real socket).
//
// Usage: bun scripts/smoke.ts            (boots its own server)
//        bun scripts/smoke.ts <baseUrl>  (probes an already-running server; needs TOOL_SECRET, OPS_USER, OPS_PASSWORD)

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const external = process.argv[2];
const port = 3000 + Math.floor(Math.random() * 2000) + 1000;
const dir = external ? "" : mkdtempSync(join(tmpdir(), "quote-smoke-"));
// Hermetic: a self-booted server ALWAYS gets fixed test secrets (Bun auto-loads .env, so falling
// back to process.env would silently test with real production secrets and hide config bugs).
// Real secrets are used only when probing an external, already-running server.
const TEST_ENV = {
  TOOL_SECRET: "smoke-tool-secret-smoke-tool-secret",
  ADMIN_SECRET: "smoke-admin-secret-smoke-admin",
  INITIATION_SECRET: "smoke-initiation-secret-smoke-init",
  LICENSE_HMAC_KEY: "smoke-hmac-key-smoke-hmac-key",
  DATA_ENCRYPTION_KEY: "c21va2Utc21va2Utc21va2Utc21va2Utc21va2UtMDE=",
  OPS_USER: "smoke",
  OPS_PASSWORD: "smoke-password",
};
const env = external
  ? { ...TEST_ENV, TOOL_SECRET: process.env.TOOL_SECRET ?? "", ADMIN_SECRET: process.env.ADMIN_SECRET ?? "", INITIATION_SECRET: process.env.INITIATION_SECRET ?? "", OPS_USER: process.env.OPS_USER ?? "", OPS_PASSWORD: process.env.OPS_PASSWORD ?? "" }
  : TEST_ENV;
const base = external ?? `http://127.0.0.1:${port}`;

let server: ReturnType<typeof Bun.spawn> | null = null;
let logs = "";
if (!external) {
  // cwd is the empty temp dir so Bun cannot auto-load the repo's .env into the test server.
  server = Bun.spawn(["bun", join(new URL("..", import.meta.url).pathname, "src/index.ts")], {
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...env, PORT: String(port), DATABASE_PATH: join(dir, "smoke.sqlite"), VPIC_TIMEOUT_MS: "1", ALERTS_DISABLED: "1", NODE_ENV: "test" },
    cwd: dir,
    stdout: "pipe",
    stderr: "pipe",
  });
  const drain = async (stream: ReadableStream<Uint8Array>) => {
    for await (const chunk of stream) logs += new TextDecoder().decode(chunk);
  };
  void drain(server.stdout as ReadableStream<Uint8Array>);
  void drain(server.stderr as ReadableStream<Uint8Array>);
  // Cold CI runners can take several seconds to boot; wait up to 30s, and fail loudly with the
  // server's own output if it exits or never answers (instead of a bare connection error).
  let up = false;
  for (let i = 0; i < 300 && !up; i++) {
    if (server.exitCode !== null) break;
    try {
      up = (await fetch(`${base}/health`)).ok;
    } catch {}
    if (!up) await Bun.sleep(100);
  }
  if (!up) {
    console.error(`FAIL server did not come up (exit code ${server.exitCode ?? "still running"})\n--- server output ---\n${logs}`);
    server.kill("SIGKILL");
    rmSync(dir, { recursive: true, force: true });
    process.exit(1);
  }
}

const failures: string[] = [];
const check = (cond: boolean, what: string) => {
  console.log(`${cond ? "ok  " : "FAIL"} ${what}`);
  if (!cond) failures.push(what);
};
const auth = { authorization: "Basic " + Buffer.from(`${env.OPS_USER}:${env.OPS_PASSWORD}`).toString("base64") };
const tool = async (name: string, body: Record<string, unknown>, secret = env.TOOL_SECRET) => {
  const res = await fetch(`${base}/tools/${name}`, { method: "POST", headers: { "content-type": "application/json", "x-tool-secret": secret }, body: JSON.stringify(body) });
  return { status: res.status, type: res.headers.get("content-type") ?? "", json: (await res.json().catch(() => ({}))) as any };
};

try {
  // Content types + hiding (the octet-stream bug class)
  const root = await fetch(`${base}/`, { redirect: "manual" });
  check(root.status === 302 && root.headers.get("location") === "/ops", "/ redirects to /ops");
  const robots = await fetch(`${base}/robots.txt`);
  check((robots.headers.get("content-type") ?? "").startsWith("text/plain"), "/robots.txt is text/plain");
  const health = await fetch(`${base}/health`);
  check((health.headers.get("content-type") ?? "").includes("application/json"), "/health is JSON");
  check((health.headers.get("x-robots-tag") ?? "").includes("noindex"), "noindex header present");
  const ready = await fetch(`${base}/ready`);
  check(ready.status === 200, "/ready reports the database writable");

  // Auth
  const opsNoAuth = await fetch(`${base}/ops`);
  check(opsNoAuth.status === 401 && (opsNoAuth.headers.get("www-authenticate") ?? "").startsWith("Basic"), "/ops prompts for login");
  check((await tool("get_quote", { conversation_id: "x" }, "wrong-secret-wrong-secret-wrong")).status === 401, "tools reject a wrong secret");

  // NJ flow (no VIN, so no external dependency)
  const C = { conversation_id: `conv_smoke_nj_${Date.now()}` };
  check((await tool("start_quote", { ...C, caller_name: "Smoke Test", zip: "08540", prior_insurance_months: 24 })).json.ok, "NJ start_quote");
  check(
    (await tool("save_driver", { ...C, driver_index: 1, first_name: "Smoke", last_name: "Smith", date_of_birth: "1985-06-01", license_state: "NJ", license_number: "S 1000 0000 0000 01", years_licensed: 18, tickets_3y: 0, at_fault_accidents_3y: 0, dui_3y: false })).json.ok,
    "NJ save_driver with grouped license",
  );
  check((await tool("save_vehicle", { ...C, vehicle_index: 1, year: 2020, make: "Toyota", model: "Camry", usage: "commute", annual_miles: 12000 })).json.ok, "NJ save_vehicle");
  check((await tool("set_coverage", { ...C, package: "recommended", pay_in_full: false })).json.ok, "NJ set_coverage");
  const q = await tool("get_quote", C);
  check(q.json.ok && q.json.six_month_premium > 0 && q.type.includes("application/json"), "NJ get_quote prices");
  const app = await tool("submit_application", { ...C, quote_hash: q.json.quote_hash, caller_confirmed: true, first_name: "Smoke", last_name: "Smith" });
  check(/^ANA-\d{7}$/.test(app.json.application_number ?? ""), "NJ application issued");

  // PA flow with the tort election
  const P = { conversation_id: `conv_smoke_pa_${Date.now()}` };
  check((await tool("start_quote", { ...P, caller_name: "Smoke Harar", zip: "18947", prior_insurance_months: 24 })).json.tort_choice_required === true, "PA start_quote requires tort");
  await tool("save_driver", { ...P, driver_index: 1, first_name: "Smoke", last_name: "Harar", date_of_birth: "1990-01-01", license_state: "PA", license_number: "1234 5678", years_licensed: 10, tickets_3y: 0, at_fault_accidents_3y: 0, dui_3y: false });
  await tool("save_vehicle", { ...P, vehicle_index: 1, year: 2019, make: "Honda", model: "Civic", usage: "commute", annual_miles: 9000 });
  check((await tool("set_coverage", { ...P, package: "recommended", pay_in_full: true })).json.error === "TORT_OPTION_REQUIRED", "PA refuses coverage without a tort election");
  await tool("set_coverage", { ...P, package: "recommended", pay_in_full: true, tort_option: "limited" });
  const pq = await tool("get_quote", P);
  check(pq.json.ok && pq.json.tort_option === "limited tort", "PA get_quote prices with limited tort");

  // PA with no license number: an estimate (no quote_hash) that can't be submitted, then add_license turns it into a real quote
  const L = { conversation_id: `conv_smoke_lic_${Date.now()}` };
  await tool("start_quote", { ...L, caller_name: "Smoke Early", zip: "18947", prior_insurance_months: 24 });
  check((await tool("save_driver", { ...L, driver_index: 1, first_name: "Smoke", last_name: "Early", date_of_birth: "1990-01-01", license_state: "PA", years_licensed: 10, tickets_3y: 0, at_fault_accidents_3y: 0, dui_3y: false })).json.ok, "PA save_driver without a license number");
  await tool("save_vehicle", { ...L, vehicle_index: 1, year: 2019, make: "Honda", model: "Civic", usage: "commute", annual_miles: 9000 });
  await tool("set_coverage", { ...L, package: "recommended", pay_in_full: false, tort_option: "full" });
  const est = await tool("get_quote", L);
  check(est.json.ok && est.json.estimate === true && est.json.six_month_premium > 0 && est.json.quote_hash === undefined, "PA get_quote without a license is an estimate with no quote_hash");
  check(Array.isArray(est.json.ways_to_lower) && est.json.ways_to_lower.length > 0, "the estimate lists ways_to_lower");
  const early = await tool("submit_application", { ...L, quote_hash: "NOHASH0000", caller_confirmed: true, first_name: "Smoke", last_name: "Early" });
  check(early.json.ok === false && early.json.error === "LICENSE_NEEDED", "submit_application on an estimate is refused with LICENSE_NEEDED");
  check((await tool("add_license", { ...L, driver_index: 1, license_number: "1234 5678" })).json.ok, "add_license saves the number");
  const final = await tool("get_quote", L);
  check(final.json.ok && !final.json.estimate && /^[0-9A-F]{10}$/.test(final.json.quote_hash ?? "") && Array.isArray(final.json.ways_to_lower), "PA get_quote after add_license is priced, with quote_hash and ways_to_lower");
  const lateApp = await tool("submit_application", { ...L, quote_hash: final.json.quote_hash, caller_confirmed: true, first_name: "Smoke", last_name: "Early" });
  check(/^ANA-\d{7}$/.test(lateApp.json.application_number ?? ""), "application issues once the license is in");

  // Returning caller: the call-start webhook mints a resume code for a number with an unfinished quote; resume_quote carries it over
  if (env.INITIATION_SECRET) {
    const callerId = `+1215555${String(Date.now()).slice(-4)}`;
    const initiate = async (conversation_id: string) => {
      const res = await fetch(`${base}/webhooks/elevenlabs/initiation`, { method: "POST", headers: { "content-type": "application/json", "x-initiation-secret": env.INITIATION_SECRET }, body: JSON.stringify({ caller_id: callerId, conversation_id }) });
      return { status: res.status, json: (await res.json().catch(() => ({}))) as any };
    };
    const first = { conversation_id: `conv_smoke_ret1_${Date.now()}` };
    check((await initiate(first.conversation_id)).json.conversation_config_override === undefined, "initiation: a first-time number gets the agent defaults");
    await tool("start_quote", { ...first, caller_name: "Smoke Return", zip: "18947", prior_insurance_months: 24 });
    await tool("save_driver", { ...first, driver_index: 1, first_name: "Smoke", last_name: "Return", date_of_birth: "1990-01-01", license_state: "PA", years_licensed: 10, tickets_3y: 0, at_fault_accidents_3y: 0, dui_3y: false });
    await tool("save_vehicle", { ...first, vehicle_index: 1, year: 2019, make: "Honda", model: "Civic", usage: "commute", annual_miles: 9000 });
    await tool("set_coverage", { ...first, package: "recommended", pay_in_full: false, tort_option: "full" });
    const again = { conversation_id: `conv_smoke_ret2_${Date.now()}` };
    const init = await initiate(again.conversation_id);
    const code = /resume_code "([A-Z0-9]+)"/.exec(init.json.conversation_config_override?.agent?.prompt?.prompt ?? "")?.[1];
    check(init.status === 200 && !!code, "initiation: the same number calling back gets a resume code");
    const resumed = await tool("resume_quote", { ...again, resume_code: code ?? "MISSING", date_of_birth: "1990-01-01" });
    check(resumed.json.ok && resumed.json.first_name === "Smoke" && resumed.json.license_needed_for?.includes("Smoke"), "resume_quote carries the saved quote over and asks for the missing license");
    check(resumed.json.resume_at === "price", `resume_quote reports where to pick up (resume_at ${resumed.json.resume_at})`);
    check((await tool("add_license", { ...again, driver_index: 1, license_number: "1234 5678" })).json.ok, "add_license works on the resumed quote");
    const resumedQuote = await tool("get_quote", again);
    check(resumedQuote.json.ok && !resumedQuote.json.estimate && !!resumedQuote.json.quote_hash, "the resumed quote prices with a quote_hash");
  } else {
    console.log("skip returning-caller flow (no INITIATION_SECRET)");
  }

  // MI flow: territory from the garaging city, and the PIP eligibility two-step
  const M = { conversation_id: `conv_smoke_mi_${Date.now()}` };
  const miStart = { ...M, caller_name: "Smoke Brooks", zip: "48226", prior_insurance_months: 24 };
  check((await tool("start_quote", miStart)).json.error === "CITY_REQUIRED", "MI start_quote asks for the garaging city");
  check((await tool("start_quote", { ...miStart, garaging_city: "Detroit" })).json.pip_choice_required === true, "MI start_quote with a city requires the PIP choice");
  await tool("save_driver", { ...M, driver_index: 1, first_name: "Smoke", last_name: "Brooks", date_of_birth: "1958-03-03", license_state: "MI", license_number: "B 123 456 789 012", years_licensed: 40, tickets_3y: 0, at_fault_accidents_3y: 0, dui_3y: false });
  await tool("save_vehicle", { ...M, vehicle_index: 1, year: 2018, make: "Ford", model: "Fusion", usage: "pleasure", annual_miles: 8000 });
  const miCoverage = { ...M, package: "recommended", pay_in_full: false, pip_medical: "opt_out" };
  check((await tool("set_coverage", miCoverage)).json.error === "PIP_ELIGIBILITY_CHECK", "MI opt-out waits for confirmed eligibility");
  check((await tool("set_coverage", { ...miCoverage, pip_confirmed: true })).json.ok, "MI opt-out records after confirmation");
  const mq = await tool("get_quote", M);
  check(mq.json.ok && mq.json.mcca_fee_included === 9.5, "MI get_quote includes the MCCA assessment");

  // Summary page over the wire
  const summary = await fetch(`${base}/q/${app.json.application_number}`, { headers: auth });
  const html = await summary.text();
  check(summary.status === 200 && (summary.headers.get("content-type") ?? "").includes("text/html"), "summary page is HTML");
  check(html.includes("DEMO") && html.includes("••••0001") && !html.includes("S10000000000001"), "summary is DEMO-stamped and masks the license");
  check((summary.headers.get("content-security-policy") ?? "").includes("default-src 'none'"), "summary page sends a CSP");
} finally {
  if (server) {
    server.kill("SIGTERM");
    await server.exited;
    check(!logs.includes("S10000000000001"), "no full license number in server logs");
    check(logs.includes('"message":"shutdown complete"'), "graceful shutdown on SIGTERM");
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log(failures.length ? `\n${failures.length} smoke check(s) failed` : "\nall smoke checks passed");
process.exit(failures.length ? 1 : 0);
