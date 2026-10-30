import { beforeEach, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config";
import { openDb, Repo } from "../src/db";
import { Alerter, inQuietHours, type AlertSettings } from "../src/ops/alerts";
import { createBackup, fsStore, restoreSnapshot } from "../src/ops/backup";
import { runRetention } from "../src/ops/retention";
import { Scheduler } from "../src/ops/scheduler";
import { createFieldCipher } from "../src/security/crypto";
import { SlidingWindowLimiter } from "../src/security/rateLimit";
import { createApp, LIMITS } from "../src/server/app";
import { fetchConversation, maskDigits } from "../src/server/transcript";
import { QuoteService } from "../src/service";

const KEY_A = Buffer.alloc(32, 1).toString("base64");
const KEY_B = Buffer.alloc(32, 2).toString("base64");
const SECRET = "test-secret-test-secret-123456";
const PREV_SECRET = "previous-secret-previous-secret-1";
const ADMIN = "admin-secret-admin-secret-1234";
const WEBHOOK = "whsec_test_secret";
const NOW = new Date("2026-10-15T15:00:00Z"); // 11:00 New York, outside quiet hours

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Records outbound alert traffic instead of hitting Telegram/Twilio. */
function fakeNet() {
  const sent: { url: string; body: string }[] = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    sent.push({ url: String(url), body: String(init?.body ?? "") });
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
  return { sent, fetchImpl };
}

const settings = (over: Partial<AlertSettings> = {}): AlertSettings => ({
  disabled: false,
  telegram: { token: "tg-token", chatId: "42" },
  voice: { accountSid: "ACtest", authToken: "auth", from: "+10000000001", to: "+10000000002" },
  quietHours: [22, 7],
  telegramCooldownMs: 15 * 60_000,
  voiceCooldownMs: 2 * 3600_000,
  voiceDailyCap: 3,
  ...over,
});

function sign(body: string, secret = WEBHOOK, t = Math.floor(NOW.getTime() / 1000)) {
  return `t=${t},v0=${createHmac("sha256", secret).update(`${t}.${body}`).digest("hex")}`;
}

function build(over: Partial<Parameters<typeof createApp>[0]> = {}) {
  const repo = new Repo(openDb(":memory:"), createFieldCipher(KEY_A));
  const net = fakeNet();
  const alerter = new Alerter(repo, settings(), () => NOW, net.fetchImpl, () => {});
  let shutting = false;
  const app = createApp({
    repo,
    service: new QuoteService({ repo, now: () => NOW, decode: async () => ({ decoded: null, source: "timeout" }), licenseKey: "k" }),
    toolSecret: SECRET,
    toolSecretPrevious: PREV_SECRET,
    adminSecret: ADMIN,
    opsUser: "max",
    opsPassword: "pw-pw-pw-pw-pw",
    webhookSecrets: [WEBHOOK, "whsec_previous"],
    canarySecret: "canary-secret-canary-secret-1",
    alerter,
    now: () => NOW,
    isShuttingDown: () => shutting,
    limiter: new SlidingWindowLimiter(() => NOW.getTime()),
    fetchMeta: async () => null,
    fetchTranscript: async () => null,
    log: () => {},
    ...over,
  });
  return { repo, app, net, alerter, setShutting: (v: boolean) => (shutting = v) };
}

const tool = (app: ReturnType<typeof createApp>, name: string, body: unknown, secret = SECRET) =>
  app.request(`/tools/${name}`, { method: "POST", headers: { "content-type": "application/json", "x-tool-secret": secret }, body: typeof body === "string" ? body : JSON.stringify(body) });
const basic = (u: string, p: string) => ({ authorization: "Basic " + Buffer.from(`${u}:${p}`).toString("base64") });

async function quoteToSubmit(app: ReturnType<typeof createApp>, id: string) {
  const C = { conversation_id: id };
  await tool(app, "start_quote", { ...C, caller_name: "Jack Harari", zip: "08540", prior_insurance_months: 24 });
  await tool(app, "save_driver", { ...C, driver_index: 1, first_name: "Jack", last_name: "Harari", date_of_birth: "2001-03-15", license_state: "PA", license_number: "1234 5678", years_licensed: 7, tickets_3y: 0, at_fault_accidents_3y: 0, dui_3y: false });
  await tool(app, "save_vehicle", { ...C, vehicle_index: 1, year: 2020, make: "Toyota", model: "Camry", usage: "commute", annual_miles: 12000 });
  await tool(app, "set_coverage", { ...C, package: "recommended", pay_in_full: false });
  return (await (await tool(app, "get_quote", C)).json()) as { quote_hash: string };
}

// ── Configuration ───────────────────────────────────────────────────────────

describe("configuration", () => {
  const good = { TOOL_SECRET: SECRET, ADMIN_SECRET: ADMIN, OPS_USER: "max", OPS_PASSWORD: "long-enough-pass", LICENSE_HMAC_KEY: "hmac-key-hmac-key", DATA_ENCRYPTION_KEY: KEY_A };

  test("production refuses to boot without its required secrets", () => {
    expect(() => loadConfig({ NODE_ENV: "production", TOOL_SECRET: SECRET })).toThrow(/missing required production secrets/);
    expect(loadConfig({ NODE_ENV: "production", ...good }).production).toBe(true);
  });

  test("weak or malformed secrets are rejected", () => {
    expect(() => loadConfig({ ...good, TOOL_SECRET: "short" })).toThrow(/TOOL_SECRET/);
    expect(() => loadConfig({ ...good, DATA_ENCRYPTION_KEY: Buffer.alloc(16).toString("base64") })).toThrow(/32 bytes/);
    expect(() => loadConfig({ ...good, OPS_PASSWORD: "short" })).toThrow(/OPS_PASSWORD/);
  });

  test("quiet hours parse, and retention defaults to dry-run", () => {
    const cfg = loadConfig({ ...good, ALERT_QUIET_HOURS: "23-6" });
    expect(cfg.quietHours).toEqual([23, 6]);
    expect(cfg.RETENTION_MODE).toBe("dry-run");
  });
});

// ── Encryption at rest ──────────────────────────────────────────────────────

describe("field encryption", () => {
  test("round-trips, uses a fresh IV per value, and detects tampering", () => {
    const c = createFieldCipher(KEY_A);
    const a = c.encrypt("1988-03-02");
    const b = c.encrypt("1988-03-02");
    expect(a).not.toBe(b);
    expect(c.decrypt(a)).toBe("1988-03-02");
    // Swap the 4th-from-last character for a different one (keying off that same character, so it always changes).
    const tampered = a.slice(0, -4) + (a.at(-4) === "A" ? "B" : "A") + a.slice(-3);
    expect(tampered).not.toBe(a);
    expect(() => c.decrypt(tampered)).toThrow();
  });

  test("key rotation: the previous key still decrypts, new writes use the current key", () => {
    const old = createFieldCipher(KEY_A).encrypt("+12155550000");
    const rotated = createFieldCipher(KEY_B, KEY_A);
    expect(rotated.decrypt(old)).toBe("+12155550000");
    expect(() => createFieldCipher(KEY_B).decrypt(old)).toThrow(/unknown key/);
    expect(rotated.decrypt(rotated.encrypt("x"))).toBe("x");
  });

  test("legacy plaintext passes through (dual-read during backfill)", () => {
    expect(createFieldCipher(KEY_A).decrypt("1988-03-02")).toBe("1988-03-02");
  });

  test("DOB, caller phone, and email are ciphertext in the database and plaintext through the repo", async () => {
    const { repo, app } = build();
    const q = await quoteToSubmit(app, "conv_enc");
    repo.setCallerPhone("conv_enc", "+12155550123");
    await tool(app, "submit_application", { conversation_id: "conv_enc", quote_hash: q.quote_hash, caller_confirmed: true, first_name: "Max", last_name: "Harar", email: "max@example.com" });
    const raw = JSON.stringify([repo.db.query("SELECT * FROM drivers").all(), repo.db.query("SELECT * FROM quotes").all(), repo.db.query("SELECT * FROM applications").all()]);
    for (const pii of ["2001-03-15", "+12155550123", "max@example.com"]) expect(raw).not.toContain(pii);
    expect(repo.drivers("conv_enc")[0]!.dob).toBe("2001-03-15");
    expect(repo.getQuote("conv_enc")!.caller_phone).toBe("+12155550123");
    expect(repo.applicationByQuote("conv_enc")!.email).toBe("max@example.com");
  });

  test("backfill encrypts legacy plaintext rows exactly once", () => {
    const repo = new Repo(openDb(":memory:"), createFieldCipher(KEY_A));
    repo.db.exec("INSERT INTO quotes (id, caller_phone) VALUES ('legacy', '+12155550199')");
    repo.db.exec("INSERT INTO drivers (quote_id, driver_index, first_name, last_name, dob, license_state, license_hash, license_last4, years_licensed, sr_tickets_3y, sr_at_fault_3y, sr_dui_3y) VALUES ('legacy', 1, 'A', 'B', '1970-01-01', 'NJ', 'h', '0001', 30, 0, 0, 0)");
    expect(repo.encryptLegacyRows()).toEqual({ drivers: 1, quotes: 1, applications: 0 });
    expect(repo.encryptLegacyRows()).toEqual({ drivers: 0, quotes: 0, applications: 0 });
    expect(String(repo.db.query("SELECT dob FROM drivers").get() && (repo.db.query("SELECT dob FROM drivers").get() as { dob: string }).dob)).toStartWith("enc:v1:");
    expect(repo.drivers("legacy")[0]!.dob).toBe("1970-01-01");
  });
});

// ── HTTP hardening ──────────────────────────────────────────────────────────

describe("HTTP hardening", () => {
  test("security headers and a request id on every response", async () => {
    const { app } = build();
    const res = await app.request("/health");
    expect(res.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(res.headers.get("strict-transport-security")).toContain("max-age=31536000");
    expect(res.headers.get("permissions-policy")).toContain("microphone=()");
    expect(res.headers.get("x-request-id")).toBeTruthy();
    expect((await app.request("/health", { headers: { "x-railway-request-id": "rid-123" } })).headers.get("x-request-id")).toBe("rid-123");
  });

  test("oversized tool bodies get 413; webhooks may be larger", async () => {
    const { app } = build();
    const big = JSON.stringify({ conversation_id: "x", pad: "a".repeat(LIMITS.smallBodyBytes + 10) });
    expect((await tool(app, "get_quote", big)).status).toBe(413);
    const hook = JSON.stringify({ type: "post_call_transcription", data: { conversation_id: "conv_big", status: "done", metadata: {}, pad: "b".repeat(100_000) } });
    expect((await app.request("/webhooks/elevenlabs", { method: "POST", headers: { "elevenlabs-signature": sign(hook) }, body: hook })).status).toBe(200);
  });

  test("the previous tool secret keeps working during a rotation", async () => {
    const { app } = build();
    expect((await tool(app, "get_quote", { conversation_id: "x" }, PREV_SECRET)).status).toBe(200);
    expect((await tool(app, "get_quote", { conversation_id: "x" }, "unknown-secret-unknown-secret-x")).status).toBe(401);
  });

  test("failed logins are throttled per IP (even a correct password is refused once throttled)", async () => {
    const { app, repo } = build();
    const h = { "x-forwarded-for": "203.0.113.9" };
    for (let i = 0; i < LIMITS.authFailuresPerIp.limit; i++) expect((await app.request("/ops", { headers: { ...h, ...basic("max", "wrong") } })).status).toBe(401);
    expect((await app.request("/ops", { headers: { ...h, ...basic("max", "pw-pw-pw-pw-pw") } })).status).toBe(429);
    expect((await app.request("/ops", { headers: { "x-forwarded-for": "198.51.100.1", ...basic("max", "pw-pw-pw-pw-pw") } })).status).toBe(200);
    expect((await app.request("/admin/quotes?eval_tag=x", { headers: { ...h, "x-admin-secret": ADMIN } })).status).toBe(429);
    expect(repo.recentAccess(50).some((a) => a.status === 401 && a.path === "/ops")).toBe(true);
  });

  test("tool calls are capped per conversation, not per IP", async () => {
    const { app } = build();
    const saved = { ...LIMITS.toolCallsPerConversation };
    LIMITS.toolCallsPerConversation.limit = 3;
    try {
      for (let i = 0; i < 3; i++) expect((await tool(app, "get_quote", { conversation_id: "conv_busy" })).status).toBe(200);
      const limited = await tool(app, "get_quote", { conversation_id: "conv_busy" });
      expect(limited.status).toBe(429);
      expect(((await limited.json()) as { error: string }).error).toBe("RATE_LIMITED");
      expect((await tool(app, "get_quote", { conversation_id: "conv_other" })).status).toBe(200);
    } finally {
      LIMITS.toolCallsPerConversation.limit = saved.limit;
    }
  });

  test("/ready reports writability and flips to 503 while draining", async () => {
    const { app, setShutting } = build();
    expect((await app.request("/ready")).status).toBe(200);
    setShutting(true);
    expect((await app.request("/ready")).status).toBe(503);
  });

  test("operator and admin access is audited with the principal", async () => {
    const { app, repo } = build();
    await app.request("/ops", { headers: basic("max", "pw-pw-pw-pw-pw") });
    await app.request("/admin/quotes?eval_tag=x", { headers: { "x-admin-secret": ADMIN } });
    const log = repo.recentAccess(10);
    expect(log.find((a) => a.path === "/ops")?.principal).toBe("ops:max");
    expect(log.find((a) => a.path === "/admin/quotes")?.principal).toBe("admin");
  });

  test("canary heartbeat requires its secret and records the time", async () => {
    const { app, repo } = build();
    expect((await app.request("/canary/heartbeat", { method: "POST" })).status).toBe(401);
    expect((await app.request("/canary/heartbeat", { method: "POST", headers: { "x-canary-secret": "canary-secret-canary-secret-1" } })).status).toBe(200);
    expect(repo.getMeta("canary_last_heartbeat")).toBe(NOW.toISOString());
  });
});

// ── Name confirmation before the application ────────────────────────────────

describe("applicant name confirmation", () => {
  test("the letter-by-letter spelling replaces what speech recognition heard", async () => {
    const { app, repo } = build();
    const q = await quoteToSubmit(app, "conv_name");
    const res = (await (await tool(app, "submit_application", { conversation_id: "conv_name", quote_hash: q.quote_hash, caller_confirmed: true, first_name: "Max", last_name: "Harar" })).json()) as { ok: boolean; applicant: string };
    expect(res.ok).toBe(true);
    expect(res.applicant).toBe("Max Harar");
    expect(repo.drivers("conv_name")[0]).toMatchObject({ first_name: "Max", last_name: "Harar" });
    expect(repo.getQuote("conv_name")!.caller_name).toBe("Max Harar");
    expect(repo.applicationByQuote("conv_name")!.applicant_name).toBe("Max Harar");
  });

  test("submission without a confirmed name, or with junk characters, is refused", async () => {
    const { app, repo } = build();
    const q = await quoteToSubmit(app, "conv_noname");
    expect(((await (await tool(app, "submit_application", { conversation_id: "conv_noname", quote_hash: q.quote_hash, caller_confirmed: true })).json()) as { error: string }).error).toBe("INVALID_INPUT");
    expect(((await (await tool(app, "submit_application", { conversation_id: "conv_noname", quote_hash: q.quote_hash, caller_confirmed: true, first_name: "Max", last_name: "H4R4R" })).json()) as { error: string }).error).toBe("INVALID_NAME");
    expect(repo.applicationByQuote("conv_noname")).toBeNull();
  });

  test("hyphens, apostrophes, and accents are valid names", async () => {
    const { app } = build();
    const q = await quoteToSubmit(app, "conv_intl");
    expect(((await (await tool(app, "submit_application", { conversation_id: "conv_intl", quote_hash: q.quote_hash, caller_confirmed: true, first_name: "José", last_name: "O'Brien-Núñez" })).json()) as { ok: boolean }).ok).toBe(true);
  });
});

// ── Error paths in the HTTP layer ───────────────────────────────────────────

describe("tool and webhook error paths", () => {
  /** A service whose methods blow up, to drive the catch blocks. */
  class Exploding extends QuoteService {
    override getQuote(): never {
      throw new Error("db exploded while reading license 12345678");
    }
    override initiation(): never {
      throw new Error("initiation exploded for +12155550147");
    }
  }
  const exploding = (repo: Repo) => new Exploding({ repo, now: () => NOW, licenseKey: "k" });

  test("a thrown service error is a structured INTERNAL (200), logged with digits masked, and counted in the event log", async () => {
    const lines: Record<string, unknown>[] = [];
    const repo = new Repo(openDb(":memory:"), createFieldCipher(KEY_A));
    const { app } = build({ repo, service: exploding(repo), log: (l) => lines.push(l) });
    const res = await tool(app, "get_quote", { conversation_id: "conv_boom" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: false, error: "INTERNAL", hint: expect.stringContaining("offer a transfer") });
    const err = lines.find((l) => l.level === "error")!;
    expect(err).toMatchObject({ tool: "get_quote", quote_id: "conv_boom" });
    expect(String(err.message)).toContain("db exploded");
    expect(String(err.message)).not.toContain("12345678");
    expect(repo.events("conv_boom")).toEqual([expect.objectContaining({ tool: "get_quote", ok: 0, error: "INTERNAL" })]);
  });

  test("an unknown tool is a 404 UNKNOWN_TOOL, but only after the secret checks out", async () => {
    const { app } = build();
    const res = await tool(app, "make_me_a_sandwich", { conversation_id: "conv_x" });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ ok: false, error: "UNKNOWN_TOOL", hint: "No such tool." });
    expect((await tool(app, "make_me_a_sandwich", { conversation_id: "conv_x" }, "wrong-secret-wrong-secret-xx")).status).toBe(401);
  });

  test("malformed JSON is INVALID_INPUT with a hint naming what's missing, never a 500", async () => {
    const { app } = build();
    // Unparseable bodies are treated as {}; a JSON null fails at the root ("body").
    for (const [body, missing] of [["{not json", "conversation_id"], ["", "conversation_id"], ["[1,2]", "body"], ["null", "body"]]) {
      const res = await tool(app, "get_quote", body);
      expect(res.status).toBe(200);
      const json = (await res.json()) as { ok: boolean; error: string; hint: string };
      expect({ body, ok: json.ok, error: json.error }).toEqual({ body, ok: false, error: "INVALID_INPUT" });
      expect(json.hint).toContain(`Missing or invalid: ${missing}`);
    }
  });

  test("the call-start webhook never breaks a call: a throwing service still gets a 200 with the agent defaults", async () => {
    const lines: Record<string, unknown>[] = [];
    const repo = new Repo(openDb(":memory:"), createFieldCipher(KEY_A));
    const { app } = build({ repo, service: exploding(repo), initiationSecret: "initiation-secret-initiation-secret", log: (l) => lines.push(l) });
    const res = await app.request("/webhooks/elevenlabs/initiation", {
      method: "POST",
      headers: { "content-type": "application/json", "x-initiation-secret": "initiation-secret-initiation-secret" },
      body: JSON.stringify({ caller_id: "+12155550147", conversation_id: "conv_init" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ type: "conversation_initiation_client_data", dynamic_variables: {} });
    const err = lines.find((l) => l.level === "error")!;
    expect(String(err.message)).toContain("serving defaults");
    expect(String(err.error)).not.toContain("2155550147");
  });

  test("/ready is 503 with the reason when the database won't take a write transaction", async () => {
    const { app, repo } = build();
    repo.db.exec("BEGIN");
    try {
      const res = await app.request("/ready");
      expect(res.status).toBe(503);
      const body = (await res.json()) as { ok: boolean; reason: string };
      expect(body.ok).toBe(false);
      expect(body.reason).toMatch(/transaction/i);
    } finally {
      repo.db.exec("ROLLBACK");
    }
    expect((await app.request("/ready")).status).toBe(200);
  });
});

// ── Post-call webhooks ──────────────────────────────────────────────────────

describe("ElevenLabs post-call webhooks", () => {
  const live = (over: Record<string, unknown> = {}) =>
    JSON.stringify({
      type: "post_call_transcription",
      data: {
        conversation_id: "conv_live_hook",
        agent_id: "agent_x",
        status: "done",
        metadata: { call_duration_secs: 126, termination_reason: "end_call tool", phone_call: { type: "twilio", external_number: "+12155550188" }, cost: 512 },
        analysis: { call_successful: "success", evaluation_criteria_results: { no_prohibited_questions: { result: "success" }, no_binding_claims: { result: "success" } } },
        ...over,
      },
    });

  test("valid signature → stored outcome, encrypted caller number, no alert on a healthy call", async () => {
    const { app, repo, net } = build();
    const body = live();
    const res = await app.request("/webhooks/elevenlabs", { method: "POST", headers: { "elevenlabs-signature": sign(body) }, body });
    expect(res.status).toBe(200);
    const call = repo.recentCalls(5)[0]!;
    expect(call).toMatchObject({ conversation_id: "conv_live_hook", status: "done", duration_secs: 126, caller_phone: "+12155550188", is_test: 0 });
    expect(JSON.stringify(repo.db.query("SELECT caller_phone FROM calls").all())).not.toContain("2155550188");
    expect(net.sent.length).toBe(0);
  });

  test("bad signature, stale timestamp, and missing header are rejected; the previous secret is accepted", async () => {
    const { app } = build();
    const body = live();
    const post = (sig?: string) => app.request("/webhooks/elevenlabs", { method: "POST", headers: sig ? { "elevenlabs-signature": sig } : {}, body });
    expect((await post(sign(body, "wrong-secret"))).status).toBe(401);
    expect((await post(sign(body, WEBHOOK, Math.floor(NOW.getTime() / 1000) - 3600))).status).toBe(401);
    expect((await post()).status).toBe(401);
    expect((await post(sign(body, "whsec_previous"))).status).toBe(200);
  });

  test("a failed live call pages: Telegram + phone call", async () => {
    const { app, net } = build();
    const body = live({ status: "failed", metadata: { phone_call: { type: "twilio" }, error: { reason: "Missing required dynamic variables in tools" } } });
    await app.request("/webhooks/elevenlabs", { method: "POST", headers: { "elevenlabs-signature": sign(body) }, body });
    expect(net.sent.some((s) => s.url.includes("api.telegram.org"))).toBe(true);
    expect(net.sent.some((s) => s.url.includes("api.twilio.com"))).toBe(true);
  });

  test("a policy-check failure on a live call warns on Telegram only", async () => {
    const { app, net } = build();
    const body = live({ analysis: { evaluation_criteria_results: { no_binding_claims: { result: "failure" } } } });
    await app.request("/webhooks/elevenlabs", { method: "POST", headers: { "elevenlabs-signature": sign(body) }, body });
    expect(net.sent.filter((s) => s.url.includes("telegram")).length).toBe(1);
    expect(net.sent.some((s) => s.url.includes("twilio"))).toBe(false);
  });

  test("call_initiation_failure pages unless it was busy/no-answer", async () => {
    const { app, net, repo } = build();
    const body = JSON.stringify({ type: "call_initiation_failure", data: { conversation_id: "conv_fail", agent_id: "a", failure_reason: "unknown", metadata: { type: "twilio", body: {} } } });
    await app.request("/webhooks/elevenlabs", { method: "POST", headers: { "elevenlabs-signature": sign(body) }, body });
    expect(net.sent.some((s) => s.url.includes("twilio"))).toBe(true);
    expect(repo.recentCalls(5)[0]).toMatchObject({ kind: "initiation_failure", status: "initiation_failed" });
  });

  test("eval simulations and WebSocket canaries never page anyone", async () => {
    const { app, net } = build();
    for (const body of [
      live({ conversation_id: "sim_eval-x-t1", status: "failed" }),
      live({ conversation_id: "conv_canary", status: "failed", metadata: {}, conversation_initiation_client_data: { dynamic_variables: { canary: "true" } } }),
    ]) {
      expect((await app.request("/webhooks/elevenlabs", { method: "POST", headers: { "elevenlabs-signature": sign(body) }, body })).status).toBe(200);
    }
    expect(net.sent.length).toBe(0);
  });

  test("unconfigured webhook secret → 503, never an open endpoint", async () => {
    const { app } = build({ webhookSecrets: [] });
    expect((await app.request("/webhooks/elevenlabs", { method: "POST", body: live() })).status).toBe(503);
  });
});

// ── Alert routing and storm control ─────────────────────────────────────────

describe("alerting", () => {
  let repo: Repo;
  beforeEach(() => {
    repo = new Repo(openDb(":memory:"), createFieldCipher(KEY_A));
  });

  test("critical → Telegram and a phone call; warning → Telegram only", async () => {
    const net = fakeNet();
    const a = new Alerter(repo, settings(), () => NOW, net.fetchImpl, () => {});
    expect((await a.send({ key: "k1", severity: "critical", title: "down" })).channels).toEqual(["telegram", "voice"]);
    expect((await a.send({ key: "k2", severity: "warning", title: "meh" })).channels).toEqual(["telegram"]);
    const twiml = decodeURIComponent(net.sent.find((s) => s.url.includes("twilio"))!.body.replace(/\+/g, " "));
    expect(twiml).toContain("<Say");
  });

  test("cooldowns suppress repeats of the same alert", async () => {
    const net = fakeNet();
    const a = new Alerter(repo, settings(), () => NOW, net.fetchImpl, () => {});
    await a.send({ key: "flap", severity: "critical", title: "flapping" });
    const second = await a.send({ key: "flap", severity: "critical", title: "flapping" });
    expect(second.channels).toEqual([]);
    expect(second.suppressed).toEqual(["telegram:cooldown", "voice:cooldown"]);
  });

  test("quiet hours (New York) hold the phone call but still send Telegram", async () => {
    const night = new Date("2026-10-15T07:30:00Z"); // 03:30 in New York
    expect(inQuietHours(night, [22, 7])).toBe(true);
    expect(inQuietHours(NOW, [22, 7])).toBe(false);
    const a = new Alerter(repo, settings(), () => night, fakeNet().fetchImpl, () => {});
    const r = await a.send({ key: "night", severity: "critical", title: "3am" });
    expect(r.channels).toEqual(["telegram"]);
    expect(r.suppressed).toContain("voice:quiet-hours");
  });

  test("no more than 3 phone calls a day across all alerts", async () => {
    const a = new Alerter(repo, settings(), () => NOW, fakeNet().fetchImpl, () => {});
    for (let i = 0; i < 3; i++) expect((await a.send({ key: `c${i}`, severity: "critical", title: "x" })).channels).toContain("voice");
    expect((await a.send({ key: "c4", severity: "critical", title: "x" })).suppressed).toContain("voice:daily-cap");
  });

  test("disabled alerting sends nothing; a dead Telegram API never throws", async () => {
    const net = fakeNet();
    expect((await new Alerter(repo, settings({ disabled: true }), () => NOW, net.fetchImpl, () => {}).send({ key: "x", severity: "critical", title: "x" })).channels).toEqual([]);
    expect(net.sent.length).toBe(0);
    const broken = (async () => { throw new Error("network down"); }) as unknown as typeof fetch;
    const r = await new Alerter(repo, settings({ voice: undefined }), () => NOW, broken, () => {}).send({ key: "y", severity: "warning", title: "y" });
    expect(r.channels).toEqual([]);
  });
});

// ── Retention ───────────────────────────────────────────────────────────────

describe("PII retention", () => {
  function seed(repo: Repo) {
    const old = "2026-08-01T00:00:00.000Z";
    const recent = "2026-10-14T00:00:00.000Z";
    repo.db.exec(`INSERT INTO quotes (id, eval_tag, created_at) VALUES ('old_live','live','${old}'), ('new_live','live','${recent}'), ('old_eval','eval-x','2026-10-01T00:00:00.000Z')`);
    repo.db.exec(`INSERT INTO drivers (quote_id, driver_index, first_name, last_name, dob, license_state, license_hash, license_last4, years_licensed, sr_tickets_3y, sr_at_fault_3y, sr_dui_3y) VALUES ('old_live', 1, 'A', 'B', 'x', 'NJ', 'h', '0001', 1, 0, 0, 0)`);
    repo.db.exec(`INSERT INTO access_log (ip, method, path, status, created_at) VALUES ('1.1.1.1','GET','/ops',200,'${old}')`);
  }

  test("dry-run counts but deletes nothing", () => {
    const repo = new Repo(openDb(":memory:"));
    seed(repo);
    const r = runRetention(repo.db, NOW, { mode: "dry-run", liveDays: 30, evalDays: 7 });
    expect(r).toMatchObject({ quotesLive: 1, quotesTest: 1, accessLog: 1 });
    expect(repo.db.query("SELECT COUNT(*) n FROM quotes").get()).toEqual({ n: 3 });
  });

  test("enforce deletes expired rows with their children and keeps recent ones", () => {
    const repo = new Repo(openDb(":memory:"));
    seed(repo);
    runRetention(repo.db, NOW, { mode: "enforce", liveDays: 30, evalDays: 7 });
    expect((repo.db.query("SELECT id FROM quotes").all() as { id: string }[]).map((q) => q.id)).toEqual(["new_live"]);
    expect(repo.db.query("SELECT COUNT(*) n FROM drivers").get()).toEqual({ n: 0 });
    expect(repo.db.query("SELECT COUNT(*) n FROM access_log").get()).toEqual({ n: 0 });
  });
});

// ── Backups and restore drills ──────────────────────────────────────────────

describe("backups", () => {
  test("snapshot → off-box store → restore drill reproduces the data", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bk-test-"));
    try {
      const { app, repo } = build();
      const q = await quoteToSubmit(app, "conv_bk");
      await tool(app, "submit_application", { conversation_id: "conv_bk", quote_hash: q.quote_hash, caller_confirmed: true, first_name: "Max", last_name: "Harar" });
      const store = fsStore(dir);
      const b = await createBackup(repo.db, store, NOW, 14);
      expect(b).toMatchObject({ integrity: "ok", quotes: 1, applications: 1 });
      expect(b.key).toStartWith("backups/quotes-");
      const restored = await restoreSnapshot(store, join(dir, "restored.sqlite"));
      expect(restored).toMatchObject({ key: b.key, integrity: "ok", quotes: 1, applications: 1 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("snapshots older than the retention window are pruned", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bk-prune-"));
    try {
      const repo = new Repo(openDb(":memory:"));
      const store = fsStore(dir);
      await store.put("backups/quotes-ancient.sqlite.gz", new Uint8Array([1]));
      const ancient = join(dir, "backups/quotes-ancient.sqlite.gz");
      const { utimesSync } = await import("node:fs");
      utimesSync(ancient, new Date("2026-01-01"), new Date("2026-01-01"));
      const b = await createBackup(repo.db, store, NOW, 14);
      expect(b.pruned).toEqual(["backups/quotes-ancient.sqlite.gz"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a snapshot taken during concurrent writes succeeds and writes keep flowing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bk-live-"));
    try {
      const file = join(dir, "live.sqlite");
      const repo = new Repo(openDb(file));
      for (let i = 0; i < 500; i++) repo.db.query("INSERT INTO quotes (id) VALUES (?)").run(`q${i}`);
      const writer = (async () => {
        for (let i = 500; i < 700; i++) {
          repo.db.query("INSERT INTO quotes (id) VALUES (?)").run(`q${i}`);
          await Bun.sleep(0);
        }
      })();
      const b = await createBackup(repo.db, fsStore(dir), NOW, 14);
      await writer;
      expect(b.integrity).toBe("ok");
      expect(b.quotes).toBeGreaterThanOrEqual(500);
      expect(repo.db.query("SELECT COUNT(*) n FROM quotes").get()).toEqual({ n: 700 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("admin backup endpoint: 503 when unconfigured, snapshot when configured", async () => {
    expect((await build().app.request("/admin/backup", { method: "POST", headers: { "x-admin-secret": ADMIN } })).status).toBe(503);
    const dir = mkdtempSync(join(tmpdir(), "bk-admin-"));
    try {
      const { app, repo } = build({ backupStore: fsStore(dir) });
      const res = await app.request("/admin/backup", { method: "POST", headers: { "x-admin-secret": ADMIN } });
      expect(res.status).toBe(200);
      expect(JSON.parse(repo.getMeta("backup_last")!).key).toStartWith("backups/");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── Scheduled jobs ──────────────────────────────────────────────────────────

describe("scheduler", () => {
  function sched(now: () => Date, over: Record<string, unknown> = {}) {
    const repo = new Repo(openDb(":memory:"));
    const net = fakeNet();
    const alerter = new Alerter(repo, settings(), now, net.fetchImpl, () => {});
    const s = new Scheduler({ repo, alerter, limiter: new SlidingWindowLimiter(), retention: { mode: "dry-run", liveDays: 30, evalDays: 7 }, backupRetentionDays: 14, canaryExpected: true, canaryMaxSilenceHours: 3, now, log: () => {}, ...over });
    return { repo, net, s };
  }

  test("dead-man's switch: alerts only after the canary has been silent past the threshold", async () => {
    let t = NOW;
    const { repo, s, net } = sched(() => t);
    repo.setMeta("canary_last_heartbeat", NOW.toISOString());
    t = new Date(NOW.getTime() + 2 * 3600_000);
    expect(await s.deadManCheck()).toBe(false);
    t = new Date(NOW.getTime() + 4 * 3600_000);
    expect(await s.deadManCheck()).toBe(true);
    expect(net.sent.some((x) => x.body.includes("canary"))).toBe(true);
  });

  test("tool-error spike pages at 5 internal failures in 15 minutes", async () => {
    const { repo, s, net } = sched(() => NOW);
    for (let i = 0; i < 5; i++) repo.db.query("INSERT INTO call_events (quote_id, tool, ok, error, ms, created_at) VALUES ('q','get_quote',0,'INTERNAL',1,?)").run(new Date(NOW.getTime() - 60_000).toISOString());
    expect(await s.toolErrorSpike()).toBe(5);
    expect(net.sent.some((x) => x.url.includes("twilio"))).toBe(true);
  });

  test("nightly backup runs once per ~day", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bk-sched-"));
    try {
      let t = NOW;
      const { s } = sched(() => t, { backupStore: fsStore(dir) });
      expect(await s.backupIfDue()).toStartWith("backups/");
      t = new Date(NOW.getTime() + 3600_000);
      expect(await s.backupIfDue()).toBeNull();
      t = new Date(NOW.getTime() + 24 * 3600_000);
      expect(await s.backupIfDue()).toStartWith("backups/");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── Conversation view ───────────────────────────────────────────────────────

describe("conversation view", () => {
  test("masks license-like digit runs but keeps short numbers", () => {
    expect(maskDigits("my license is 2345 6789")).toBe("my license is ••••6789");
    expect(maskDigits("N12345678901234")).toBe("N••••••••••1234");
    expect(maskDigits("ZIP 08540, 24 months")).toBe("ZIP 08540, 24 months");
  });

  test("maps ElevenLabs transcripts into turns with tool calls and results", async () => {
    const fake = (async () =>
      new Response(
        JSON.stringify({
          status: "done",
          has_audio: true,
          metadata: { call_duration_secs: 70 },
          transcript: [
            { role: "agent", message: "What's your license number?", time_in_call_secs: 20 },
            { role: "user", message: "S 1000 0000 0000 01", time_in_call_secs: 25 },
            { role: "agent", message: null, time_in_call_secs: 30, tool_calls: [{ tool_name: "save_driver", params_as_json: JSON.stringify({ conversation_id: "conv_x", license_number: "S10000000000001", driver_index: 1 }) }] },
            { role: "agent", message: "", time_in_call_secs: 31, tool_results: [{ tool_name: "save_driver", is_error: false, tool_latency_secs: 0.042, result_value: JSON.stringify({ ok: true, driver_index: 1 }) }] },
          ],
        }),
      )) as unknown as typeof fetch;
    const c = (await fetchConversation("conv_x", "key", fake))!;
    expect(c.hasAudio).toBe(true);
    expect(c.durationSecs).toBe(70);
    expect(c.turns[1]!.message).toBe("S ••••••••••0001");
    expect(c.turns[2]!.tools[0]!.args).not.toContain("conversation_id");
    expect(c.turns[2]!.tools[0]!.args).not.toContain("S10000000000001");
    expect(c.turns[3]!.results[0]).toMatchObject({ name: "save_driver", ok: true, latencyMs: 42 });
  });

  test("ops call page renders the chat when a transcript is available", async () => {
    const { app } = build({
      fetchTranscript: async () => ({ status: "done", durationSecs: 70, hasAudio: true, turns: [{ role: "agent", message: "Thanks for calling", secs: 0, tools: [], results: [] }, { role: "user", message: "Max Harar", secs: 4, tools: [], results: [] }] }),
    });
    await tool(app, "start_quote", { conversation_id: "conv_chat", caller_name: "Max Harar", zip: "08540", prior_insurance_months: 1 });
    const html = await (await app.request("/ops/quote/conv_chat", { headers: basic("max", "pw-pw-pw-pw-pw") })).text();
    expect(html).toContain('class="turn agent"');
    expect(html).toContain('class="turn user"');
    expect(html).toContain("/ops/quote/conv_chat/audio");
  });
});
