import { Hono, type Context, type Next } from "hono";
import { bodyLimit } from "hono/body-limit";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { Repo } from "../db";
import type { Alerter } from "../ops/alerts";
import { createBackup, type BackupStore } from "../ops/backup";
import { runRetention, type RetentionPolicy } from "../ops/retention";
import { clientIp, SlidingWindowLimiter } from "../security/rateLimit";
import { QuoteService, type ToolResult } from "../service";
import { fetchCallMeta, type CallMeta } from "./callMeta";
import { renderOpsIndex, renderOpsQuote } from "./ops";
import { renderPolicy } from "../policy";
import { initiationResponse } from "./initiation";
import { renderSummary } from "./summary";
import { fetchAudio, fetchConversation, maskDigits, type Conversation } from "./transcript";
import { collectCallMetrics, handleWebhook, verifySignature } from "./webhooks";
import { fetchRawConversation, type RawConversation } from "../ops/callMetrics";

export const VERSION = process.env.RAILWAY_GIT_COMMIT_SHA?.slice(0, 7) ?? process.env.APP_VERSION ?? "dev";

const conversation = { conversation_id: z.string().min(1).max(128), eval_tag: z.string().max(64).optional() };

/**
 * Live calls only carry system__* dynamic variables, so the agent never sends an eval tag.
 * Eval simulations set system__conversation_id = "sim_<eval_tag>", which is where the tag comes from.
 */
export function evalTagFor(conversationId: string, explicit?: string): string {
  if (explicit) return explicit;
  return conversationId.startsWith("sim_eval-") ? conversationId.slice(4) : "live";
}
const int = (min: number, max: number) => z.coerce.number().int().min(min).max(max);
const bool = z.preprocess((v) => (v === "true" ? true : v === "false" ? false : v), z.boolean());
/** Empty string = not provided: tool callers send "" for optional fields they omit. */
const emptyToUndefined = (v: unknown) => (v === "" ? undefined : v);
/** Same, also treating whitespace-only strings as not provided. */
const blankToUndefined = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);

export const TOOL_SCHEMAS = {
  start_quote: z.object({
    ...conversation,
    caller_name: z.string().min(1).max(120),
    zip: z.string().min(3).max(12),
    prior_insurance_months: z.coerce.number().min(0).max(600),
    caller_phone: z.string().max(32).nullish(),
    // Michigan only: territories are municipal there, so the server asks for the garaging city (empty = not given).
    garaging_city: z.preprocess(blankToUndefined, z.string().min(1).max(80).optional()),
  }),
  save_driver: z.object({
    ...conversation,
    driver_index: int(1, 9),
    first_name: z.string().min(1).max(60),
    last_name: z.string().min(1).max(60),
    date_of_birth: z.string().max(20),
    license_state: z.string().length(2),
    // Optional: a caller without their license handy can finish everything else and add it later.
    license_number: z.preprocess(blankToUndefined, z.string().min(1).max(40).optional()),
    years_licensed: z.coerce.number().min(0).max(90),
    tickets_3y: int(0, 20),
    at_fault_accidents_3y: int(0, 20),
    dui_3y: bool,
  }),
  add_license: z.object({
    ...conversation,
    driver_index: int(1, 9),
    license_number: z.string().min(1).max(40),
    license_state: z.preprocess(blankToUndefined, z.string().length(2).optional()),
  }),
  save_vehicle: z.object({
    ...conversation,
    vehicle_index: int(1, 9),
    vin: z.string().max(40).nullish(),
    year: z.coerce.number().int().nullish(),
    make: z.string().max(40).nullish(),
    model: z.string().max(60).nullish(),
    usage: z.enum(["pleasure", "commute", "business", "rideshare"]),
    annual_miles: z.coerce.number().min(0).max(200000),
    anti_theft: bool.optional(),
  }),
  set_coverage: z.object({
    ...conversation,
    package: z.enum(["minimum", "recommended", "premium"]),
    pay_in_full: bool,
    // Empty string = not provided (the agent omits it for New Jersey).
    tort_option: z.preprocess(emptyToUndefined, z.enum(["limited", "full"]).optional()),
    // Michigan only: the PIP medical election, and whether its eligibility and disclosure were confirmed.
    pip_medical: z.preprocess(emptyToUndefined, z.enum(["unlimited", "500k", "250k", "250k_excluded", "50k", "opt_out"]).optional()),
    pip_confirmed: z.preprocess(emptyToUndefined, bool.optional()),
  }),
  get_quote: z.object({ ...conversation }),
  submit_application: z.object({
    ...conversation,
    quote_hash: z.string().min(4).max(32),
    caller_confirmed: bool,
    first_name: z.string().min(1).max(60),
    last_name: z.string().min(1).max(60),
    email: z.string().max(120).nullish(),
  }),
  // conversation_id and last_name are optional: the previous agent sends only the number (review 2026-10-16).
  lookup_application: z.object({
    conversation_id: conversation.conversation_id.optional(),
    eval_tag: conversation.eval_tag,
    application_number: z.string().min(4).max(40),
    last_name: z.preprocess(blankToUndefined, z.string().min(1).max(60).optional()),
  }),
  resume_quote: z.object({ ...conversation, resume_code: z.string().min(4).max(12), date_of_birth: z.string().max(20) }),
  flag_for_human: z.object({
    ...conversation,
    reason: z.enum(["caller_requested", "out_of_state", "underwriting_referral", "claims_billing_or_policy_service", "coverage_advice", "complaint", "declined_recording", "other"]),
    summary: z.string().max(400).optional(),
  }),
} as const;
export type ToolName = keyof typeof TOOL_SCHEMAS;

function secretOk(given: string | undefined, expected: string | undefined): boolean {
  if (!expected) return false;
  const a = Buffer.from(given ?? "");
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
const anySecretOk = (given: string | undefined, secrets: (string | undefined)[]) => secrets.some((s) => secretOk(given, s));

/** Abuse limits. Tools are keyed per conversation (ElevenLabs shares egress IPs, so per-IP would throttle real calls). */
export const LIMITS = {
  toolCallsPerConversation: { limit: 300, windowMs: 10 * 60_000 },
  authFailuresPerIp: { limit: 20, windowMs: 15 * 60_000 },
  smallBodyBytes: 32 * 1024,
  webhookBodyBytes: 5 * 1024 * 1024,
};

const CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; media-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

export interface AppOptions {
  repo: Repo;
  service?: QuoteService;
  /** Current tool secret plus, during a rotation, the previous one. */
  toolSecret: string;
  toolSecretPrevious?: string;
  adminSecret?: string;
  /** Basic-auth creds gating /ops and /q. When unset, those routes are closed (503), never open. */
  opsUser?: string;
  opsPassword?: string;
  elevenAgentId?: string;
  elevenApiKey?: string;
  webhookSecrets?: string[];
  /** Header secret ElevenLabs sends to the call-start (initiation) webhook. Unset = endpoint disabled. */
  initiationSecret?: string;
  canarySecret?: string;
  alerter?: Alerter;
  backupStore?: BackupStore;
  backupRetentionDays?: number;
  retention?: RetentionPolicy;
  publicBaseUrl?: string;
  toolTimeoutMs?: number;
  isShuttingDown?: () => boolean;
  now?: () => Date;
  fetchMeta?: (id: string) => Promise<CallMeta | null>;
  /** Raw ElevenLabs conversation for per-call quality metrics (tests inject a fixture). */
  fetchRawConversation?: (id: string) => Promise<RawConversation | null>;
  /** Tests await this to observe the off-path metrics collection. */
  onCallMetrics?: (p: Promise<unknown>) => void;
  fetchTranscript?: (id: string) => Promise<Conversation | null>;
  fetchAudio?: (id: string) => Promise<Response | null>;
  limiter?: SlidingWindowLimiter;
  log?: (line: Record<string, unknown>) => void;
}

/** Parses one "bytes=start-end" range. null = no usable range (send the whole file); "unsatisfiable" = 416. */
export function byteRange(header: string | undefined, total: number): { start: number; end: number } | null | "unsatisfiable" {
  const m = /^bytes=(\d*)-(\d*)$/.exec((header ?? "").trim());
  if (!m || (!m[1] && !m[2])) return null;
  let start: number;
  let end: number;
  if (!m[1]) {
    // Suffix range: the last N bytes.
    const n = Number(m[2]);
    if (n === 0) return "unsatisfiable";
    start = Math.max(0, total - n);
    end = total - 1;
  } else {
    start = Number(m[1]);
    end = m[2] ? Math.min(Number(m[2]), total - 1) : total - 1;
  }
  if (start >= total || start > end) return "unsatisfiable";
  return { start, end };
}

/** A few recently played recordings, in memory only, so seeking doesn't refetch from ElevenLabs. */
export function createAudioCache(max = 6, ttlMs = 10 * 60_000, now: () => number = Date.now) {
  const entries = new Map<string, { buf: ArrayBuffer; at: number }>();
  return {
    get(id: string): ArrayBuffer | undefined {
      const e = entries.get(id);
      if (!e) return undefined;
      entries.delete(id);
      if (now() - e.at > ttlMs) return undefined;
      entries.set(id, e);
      return e.buf;
    },
    put(id: string, buf: ArrayBuffer): ArrayBuffer {
      entries.set(id, { buf, at: now() });
      while (entries.size > max) entries.delete(entries.keys().next().value!);
      return buf;
    },
  };
}

export function createApp(opts: AppOptions) {
  const audioCache = createAudioCache();
  const { repo } = opts;
  const now = opts.now ?? (() => new Date());
  const service = opts.service ?? new QuoteService({ repo, now });
  const log = opts.log ?? ((l) => console.log(JSON.stringify(l)));
  const limiter = opts.limiter ?? new SlidingWindowLimiter();
  const baseUrl = opts.publicBaseUrl ?? "https://quoteline.maxharar.com";
  // Newest call per (conversation, tool, index) slot; the counter is process-wide so a sequence number is never reused.
  let toolSeqCounter = 0;
  const latestToolSeq = new Map<string, number>();
  // resume_quote replaces this call's drivers, vehicles and coverage wholesale, so any write that started before it is
  // about a quote that no longer exists. Bumped when resume_quote dispatches and folded into isStale (review 2026-10-16).
  // One small integer per conversation that ever resumed; a process restart forgets it along with the in-flight work.
  const resumeEpoch = new Map<string, number>();
  const app = new Hono<{ Variables: { requestId: string; principal: string | null; audited: boolean } }>();

  // 1. Request id + security headers. Set BEFORE the handler so they ride on the response it builds;
  // setting them after next() forces Hono to re-wrap the response, and plain-text bodies lose their
  // implicit content-type (the root URL was once served as application/octet-stream).
  app.use("*", async (c, next) => {
    const requestId = c.req.header("x-railway-request-id") ?? c.req.header("x-request-id") ?? randomUUID();
    c.set("requestId", requestId);
    c.set("principal", null);
    c.header("X-Request-Id", requestId);
    c.header("X-Robots-Tag", "noindex, nofollow, noarchive");
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Referrer-Policy", "no-referrer");
    c.header("X-Frame-Options", "DENY");
    c.header("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    c.header("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()");
    c.header("Cross-Origin-Opener-Policy", "same-origin");
    c.header("Content-Security-Policy", CSP);
    await next();
  });

  // 2. Body limits per route class (webhooks carry call analysis; everything else is tiny).
  const small = bodyLimit({ maxSize: LIMITS.smallBodyBytes, onError: (c) => c.json({ ok: false, error: "PAYLOAD_TOO_LARGE" }, 413) });
  app.use("/tools/*", small);
  app.use("/admin/*", small);
  app.use("/canary/*", small);
  app.use("/webhooks/*", bodyLimit({ maxSize: LIMITS.webhookBodyBytes, onError: (c) => c.json({ ok: false, error: "PAYLOAD_TOO_LARGE" }, 413) }));

  // 3. Access audit for everything an operator or admin can reach (append-only).
  const audit = async (c: Context, next: Next) => {
    // "/ops" and "/ops/*" both match /ops; log each request once.
    if (c.get("audited")) return next();
    c.set("audited", true);
    await next();
    repo.logAccess({
      ip: clientIp((h) => c.req.header(h)),
      method: c.req.method,
      path: c.req.path,
      status: c.res.status,
      principal: c.get("principal") ?? null,
      request_id: c.get("requestId") ?? null,
    });
  };
  app.use("/ops", audit);
  app.use("/ops/*", audit);
  app.use("/q/*", audit);
  app.use("/admin/*", audit);

  /** Throttles credential guessing per client IP. Returns a 429 response when over the limit. */
  const throttled = (c: Context) => {
    const ip = clientIp((h) => c.req.header(h));
    const used = limiter.count(`authfail:${ip}`, LIMITS.authFailuresPerIp.windowMs);
    if (used >= LIMITS.authFailuresPerIp.limit) {
      log({ level: "warn", message: "auth throttled", ip, path: c.req.path });
      return c.text("Too many failed attempts. Try again later.", 429, { "Retry-After": "900" });
    }
    return null;
  };
  const failedAuth = (c: Context) => limiter.hit(`authfail:${clientIp((h) => c.req.header(h))}`, LIMITS.authFailuresPerIp.limit, LIMITS.authFailuresPerIp.windowMs);

  // 4. Basic-auth gate for the ops console and quote summaries.
  const gate = async (c: Context, next: Next) => {
    if (!opts.opsUser || !opts.opsPassword) return c.text("Ops console not configured", 503);
    const blocked = throttled(c);
    if (blocked) return blocked;
    const [scheme, encoded] = (c.req.header("authorization") ?? "").split(" ");
    let user = "";
    let pass = "";
    if (scheme === "Basic" && encoded) {
      const decoded = Buffer.from(encoded, "base64").toString("utf8");
      const idx = decoded.indexOf(":");
      user = decoded.slice(0, idx);
      pass = decoded.slice(idx + 1);
    }
    if (secretOk(user, opts.opsUser) && secretOk(pass, opts.opsPassword)) {
      c.set("principal", `ops:${user}`);
      return next();
    }
    if (encoded) failedAuth(c);
    c.header("WWW-Authenticate", `Basic realm="Quote line ops", charset="UTF-8"`);
    return c.text("Authentication required", 401);
  };
  app.use("/ops", gate);
  app.use("/ops/*", gate);
  app.use("/q/*", gate);

  /** Admin endpoints: x-admin-secret, throttled the same way. */
  const adminOk = (c: Context) => {
    const blocked = throttled(c);
    if (blocked) return blocked;
    if (!secretOk(c.req.header("x-admin-secret"), opts.adminSecret)) {
      failedAuth(c);
      return c.json({ ok: false, error: "UNAUTHORIZED" }, 401);
    }
    c.set("principal", "admin");
    return null;
  };

  app.get("/robots.txt", (c) => c.text("User-agent: *\nDisallow: /\n", 200, { "content-type": "text/plain; charset=utf-8" }));
  // The root of the hidden ops host is the login: send visitors to the dashboard (which prompts for credentials).
  app.get("/", (c) => c.redirect("/ops", 302));

  // ── Health ──
  app.get("/health", (c) => {
    const db = repo.db.query<{ ok: number }, []>("SELECT 1 AS ok").get();
    return c.json({ ok: db?.ok === 1, version: VERSION, db: db?.ok === 1 ? "up" : "down" });
  });
  /** Readiness: the database accepts a write transaction and the process isn't draining. */
  app.get("/ready", (c) => {
    if (opts.isShuttingDown?.()) return c.json({ ok: false, reason: "shutting down" }, 503);
    try {
      repo.db.exec("BEGIN IMMEDIATE");
      repo.db.exec("ROLLBACK");
      return c.json({ ok: true, version: VERSION });
    } catch (e) {
      return c.json({ ok: false, reason: (e as Error).message }, 503);
    }
  });

  // ── Agent tools ──
  app.post("/tools/:name", async (c) => {
    const started = performance.now();
    const name = c.req.param("name") as ToolName;
    if (!anySecretOk(c.req.header("x-tool-secret"), [opts.toolSecret, opts.toolSecretPrevious])) return c.json({ ok: false, error: "UNAUTHORIZED" }, 401);
    const schema = TOOL_SCHEMAS[name];
    if (!schema) return c.json({ ok: false, error: "UNKNOWN_TOOL", hint: "No such tool." }, 404);

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      body = {};
    }
    const conversationId = (body as { conversation_id?: unknown })?.conversation_id;
    const quoteId = typeof conversationId === "string" ? conversationId.slice(0, 128) : null;

    if (quoteId) {
      const lim = limiter.hit(`tools:${quoteId}`, LIMITS.toolCallsPerConversation.limit, LIMITS.toolCallsPerConversation.windowMs);
      if (!lim.allowed) {
        log({ level: "warn", message: "tool rate limited", tool: name, quote_id: quoteId, count: lim.count });
        return c.json({ ok: false, error: "RATE_LIMITED", hint: "Too many requests on this call. Offer a transfer to a licensed agent." }, 429);
      }
    }

    const parsed = schema.safeParse(body);
    let result: ToolResult;
    if (!parsed.success) {
      const fields = parsed.error.issues.map((i) => i.path.join(".") || "body");
      result = { ok: false, error: "INVALID_INPUT", hint: `Missing or invalid: ${[...new Set(fields)].join(", ")}. Ask the caller for it.` };
    } else {
      // Answer before ElevenLabs' tool timeout; every tool is idempotent, so a retry after a slow success is safe.
      // But the race only stops the wait, not the work: a timed-out save_vehicle kept running and could land AFTER
      // the agent's corrected retry, overwriting it. Each call takes a sequence number for its
      // (conversation, tool, index) slot, and a call that is no longer the newest for its slot never writes.
      const data = parsed.data as Record<string, unknown>;
      const slot = `${quoteId}:${name}:${data.vehicle_index ?? data.driver_index ?? ""}`;
      const seq = ++toolSeqCounter;
      latestToolSeq.set(slot, seq);
      if (name === "resume_quote" && quoteId) resumeEpoch.set(quoteId, (resumeEpoch.get(quoteId) ?? 0) + 1);
      const epoch = quoteId ? (resumeEpoch.get(quoteId) ?? 0) : 0;
      const isStale = () => latestToolSeq.get(slot) !== seq || (quoteId ? (resumeEpoch.get(quoteId) ?? 0) : 0) !== epoch;
      const work = dispatch(service, name, data, isStale).finally(() => {
        if (!isStale()) latestToolSeq.delete(slot);
      });
      // Promise.race subscribes to work, so a rejection is never unhandled. The late-outcome log used to be attached up
      // front: every in-time error was logged twice and marked late, and a late SUCCESS was never logged at all
      // (review 2026-10-16). Now it is attached only when the timeout actually won, and leaves an event row for ops.
      const TIMED_OUT: ToolResult = { ok: false, error: "TIMEOUT", hint: "That took too long on our side. Try once more; if it fails again, offer a licensed agent." };
      try {
        const timeoutMs = opts.toolTimeoutMs ?? 4000;
        result = await Promise.race([work, Bun.sleep(timeoutMs).then(() => TIMED_OUT)]);
        if (result === TIMED_OUT) {
          const requestId = c.get("requestId");
          const lateMs = () => Math.round(performance.now() - started);
          work.then(
            (r) => {
              log({ level: r.ok ? "info" : "warn", tool: name, quote_id: quoteId, request_id: requestId, late: true, ok: r.ok, error: r.ok ? undefined : r.error, ms: lateMs() });
              repo.logEvent({ quote_id: quoteId, tool: name, ok: r.ok, error: r.ok ? "LATE" : `LATE:${r.error}`, ms: lateMs() });
            },
            (e) => {
              log({ level: "error", tool: name, quote_id: quoteId, request_id: requestId, late: true, message: maskDigits((e as Error).message), ms: lateMs() });
              repo.logEvent({ quote_id: quoteId, tool: name, ok: false, error: "LATE:INTERNAL", ms: lateMs() });
            },
          );
        }
      } catch (e) {
        log({ level: "error", tool: name, quote_id: quoteId, request_id: c.get("requestId"), message: maskDigits((e as Error).message) });
        result = { ok: false, error: "INTERNAL", hint: "Something went wrong on our side. Apologize briefly and offer a transfer to an agent." };
      }
    }
    const ms = Math.round(performance.now() - started);
    // Event log carries no PII: tool name, outcome, latency only.
    repo.logEvent({ quote_id: quoteId, tool: name, ok: result.ok, error: result.ok ? null : result.error, ms });
    log({ level: "info", tool: name, quote_id: quoteId, request_id: c.get("requestId"), ok: result.ok, error: result.ok ? undefined : result.error, ms });
    return c.json(result);
  });

  // ── ElevenLabs post-call webhooks (HMAC-signed) ──
  app.post("/webhooks/elevenlabs", async (c) => {
    const secrets = (opts.webhookSecrets ?? []).filter(Boolean);
    if (!secrets.length || !opts.alerter) return c.json({ ok: false, error: "WEBHOOK_NOT_CONFIGURED" }, 503);
    const raw = await c.req.text();
    const v = verifySignature(c.req.header("elevenlabs-signature"), raw, secrets, Math.floor(now().getTime() / 1000));
    if (!v.ok) {
      log({ level: "warn", message: "webhook rejected", reason: v.reason, request_id: c.get("requestId") });
      return c.json({ ok: false, error: "INVALID_SIGNATURE" }, 401);
    }
    let event: { type?: string; data?: never };
    try {
      event = JSON.parse(raw);
    } catch {
      return c.json({ ok: false, error: "INVALID_JSON" }, 400);
    }
    const outcome = await handleWebhook(event, repo, opts.alerter, baseUrl, (id, phone) => service.attachCallerPhone(id, phone));
    log({ level: "info", message: "webhook", type: event.type, kind: outcome.kind, test: outcome.isTest, alerts: outcome.alerts });
    // Quality metrics need one more ElevenLabs round trip, so they run after the response; a failure only skips the row.
    const conversationId = (event.data as { conversation_id?: string } | undefined)?.conversation_id;
    if (outcome.kind === "call" && conversationId) {
      const p = collectCallMetrics(conversationId, outcome.isTest, repo, opts.alerter, baseUrl, opts.fetchRawConversation ?? ((id) => fetchRawConversation(id, opts.elevenApiKey)))
        .then((r) => log({ level: "info", message: "call metrics", conversation_id: conversationId, stored: Boolean(r.metrics), breaches: r.breaches }))
        .catch((e) => log({ level: "warn", message: "call metrics failed", error: maskDigits((e as Error).message) }));
      opts.onCallMetrics?.(p);
    }
    return c.json({ ok: true, kind: outcome.kind });
  });

  // ── Call-start personalization (returning callers) ──
  // Must never break a call: any problem returns the agent's defaults with a 200, fast.
  app.post("/webhooks/elevenlabs/initiation", async (c) => {
    const fallback = { type: "conversation_initiation_client_data", dynamic_variables: {} };
    if (!opts.initiationSecret || !secretOk(c.req.header("x-initiation-secret"), opts.initiationSecret)) {
      return c.json(opts.initiationSecret ? { ok: false, error: "UNAUTHORIZED" } : fallback, opts.initiationSecret ? 401 : 200);
    }
    try {
      const body = (await c.req.json()) as { caller_id?: string; conversation_id?: string };
      if (!body.caller_id || !body.conversation_id) return c.json(fallback);
      const result = service.initiation({ conversationId: body.conversation_id, callerId: body.caller_id });
      log({ level: "info", message: "initiation", conversation_id: body.conversation_id, returning: result.returning, ...(!result.returning && result.reason ? { reason: result.reason } : {}) });
      return c.json(initiationResponse(result, await renderPolicy()));
    } catch (e) {
      log({ level: "error", message: "initiation failed; serving defaults", error: maskDigits((e as Error).message) });
      return c.json(fallback);
    }
  });

  // ── External canary heartbeat (feeds the dead-man's switch) ──
  app.post("/canary/heartbeat", (c) => {
    if (!secretOk(c.req.header("x-canary-secret"), opts.canarySecret)) return c.json({ ok: false, error: "UNAUTHORIZED" }, 401);
    repo.setMeta("canary_last_heartbeat", now().toISOString());
    return c.json({ ok: true });
  });

  // ── Ops console ──
  app.get("/ops", (c) => c.html(renderOpsIndex(repo, { tag: c.req.query("tag"), elevenAgentId: opts.elevenAgentId })));
  app.get("/ops/quote/:id", async (c) => {
    const id = c.req.param("id");
    const [meta, convo] = await Promise.all([
      (opts.fetchMeta ?? ((cid: string) => fetchCallMeta(cid, opts.elevenApiKey)))(id),
      (opts.fetchTranscript ?? ((cid: string) => fetchConversation(cid, opts.elevenApiKey)))(id),
    ]);
    if (meta?.callerPhone && repo.getQuote(id)) service.attachCallerPhone(id, meta.callerPhone);
    const html = renderOpsQuote(repo, id, { elevenAgentId: opts.elevenAgentId, meta, conversation: convo });
    return html ? c.html(html) : c.html("<h1>Not found</h1>", 404);
  });
  // Call audio. A bare stream gave the player no length (0:00 / 0:00, no seeking), so the file is buffered and served
  // with Content-Length and byte ranges. A short in-memory cache keeps seeks from refetching; nothing touches disk.
  app.get("/ops/quote/:id/audio", async (c) => {
    const id = c.req.param("id");
    let buf = audioCache.get(id);
    if (!buf) {
      const res = await (opts.fetchAudio ?? ((cid: string) => fetchAudio(cid, opts.elevenApiKey)))(id);
      if (!res) return c.text("Audio not available", 404);
      buf = audioCache.put(id, await res.arrayBuffer());
    }
    c.header("content-type", "audio/mpeg");
    c.header("accept-ranges", "bytes");
    c.header("cache-control", "private, no-store");
    const r = byteRange(c.req.header("range"), buf.byteLength);
    if (r === "unsatisfiable") {
      c.header("content-range", `bytes */${buf.byteLength}`);
      return c.body(null, 416);
    }
    if (r) {
      c.header("content-range", `bytes ${r.start}-${r.end}/${buf.byteLength}`);
      c.header("content-length", String(r.end - r.start + 1));
      return c.body(buf.slice(r.start, r.end + 1), 206);
    }
    c.header("content-length", String(buf.byteLength));
    return c.body(buf, 200);
  });
  app.get("/favicon.ico", (c) => c.body(null, 204));

  app.get("/q/:app", (c) => {
    const application = repo.application(c.req.param("app").toUpperCase());
    if (!application) return c.html("<h1>Not found</h1>", 404);
    const quote = repo.getQuote(application.quote_id)!;
    return c.html(renderSummary({ app: application, quote, drivers: repo.drivers(quote.id), vehicles: repo.vehicles(quote.id), reports: repo.reports(quote.id) }));
  });

  // ── Admin ──
  // Eval oracle: read-only view of end state for one eval tag.
  app.get("/admin/quotes", (c) => {
    const denied = adminOk(c);
    if (denied) return denied;
    const tag = c.req.query("eval_tag");
    if (!tag) return c.json({ ok: false, error: "eval_tag required" }, 400);
    const quotes = repo.quotesByTag(tag).map((q) => ({
      ...q,
      drivers: repo.drivers(q.id).map(({ license_hash: _h, ...d }) => d),
      vehicles: repo.vehicles(q.id),
      reports: repo.reports(q.id).map((r) => ({ driver_index: r.driver_index, kind: r.kind, source: r.source })),
      application: repo.applicationByQuote(q.id),
      events: repo.events(q.id),
    }));
    return c.json({ ok: true, quotes });
  });
  // On-demand snapshot (the release script takes one before every deploy).
  app.post("/admin/backup", async (c) => {
    const denied = adminOk(c);
    if (denied) return denied;
    if (!opts.backupStore) return c.json({ ok: false, error: "BACKUPS_NOT_CONFIGURED" }, 503);
    const r = await createBackup(repo.db, opts.backupStore, now(), opts.backupRetentionDays ?? 14);
    repo.setMeta("backup_last", JSON.stringify({ at: now().toISOString(), key: r.key, bytes: r.bytes, quotes: r.quotes }));
    return c.json({ ok: true, ...r });
  });
  // Retention report (always dry-run when triggered by hand; enforcement only runs on the schedule).
  app.post("/admin/retention", (c) => {
    const denied = adminOk(c);
    if (denied) return denied;
    const policy = opts.retention ?? { mode: "dry-run" as const, liveDays: 30, evalDays: 7 };
    return c.json({ ok: true, ...runRetention(repo.db, now(), { ...policy, mode: "dry-run" }) });
  });

  return app;
}

async function dispatch(s: QuoteService, name: ToolName, d: Record<string, any>, isStale: () => boolean): Promise<ToolResult> {
  switch (name) {
    case "start_quote":
      return s.startQuote({
        conversationId: d.conversation_id,
        evalTag: evalTagFor(d.conversation_id, d.eval_tag),
        callerName: d.caller_name,
        zip: d.zip,
        priorInsuranceMonths: d.prior_insurance_months,
        callerPhone: d.caller_phone,
        garagingCity: d.garaging_city,
      });
    case "save_driver":
      return s.saveDriver({
        conversationId: d.conversation_id, driverIndex: d.driver_index, firstName: d.first_name, lastName: d.last_name, dateOfBirth: d.date_of_birth,
        licenseState: d.license_state, licenseNumber: d.license_number, yearsLicensed: d.years_licensed, tickets3y: d.tickets_3y,
        atFaultAccidents3y: d.at_fault_accidents_3y, dui3y: d.dui_3y,
      });
    case "add_license":
      return s.addLicense({ conversationId: d.conversation_id, driverIndex: d.driver_index, licenseNumber: d.license_number, licenseState: d.license_state });
    case "save_vehicle":
      return s.saveVehicle({
        conversationId: d.conversation_id, vehicleIndex: d.vehicle_index, vin: d.vin, year: d.year, make: d.make, model: d.model,
        usage: d.usage, annualMiles: d.annual_miles, antiTheft: d.anti_theft, isStale,
      });
    case "set_coverage":
      return s.setCoverage({
        conversationId: d.conversation_id,
        package: d.package,
        payInFull: d.pay_in_full,
        tortOption: d.tort_option,
        pipMedical: d.pip_medical,
        pipConfirmed: d.pip_confirmed,
      });
    case "get_quote":
      return s.getQuote({ conversationId: d.conversation_id });
    case "submit_application":
      return s.submitApplication({ conversationId: d.conversation_id, quoteHash: d.quote_hash, callerConfirmed: d.caller_confirmed, firstName: d.first_name, lastName: d.last_name, email: d.email });
    case "lookup_application":
      return s.lookupApplication({ applicationNumber: d.application_number, lastName: d.last_name });
    case "resume_quote":
      return s.resumeQuote({ conversationId: d.conversation_id, evalTag: evalTagFor(d.conversation_id, d.eval_tag), resumeCode: d.resume_code, dateOfBirth: d.date_of_birth });
    case "flag_for_human":
      return s.flagForHuman({ conversationId: d.conversation_id, evalTag: evalTagFor(d.conversation_id, d.eval_tag), reason: d.reason, summary: d.summary });
  }
}
