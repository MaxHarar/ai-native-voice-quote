import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { openDb, Repo } from "../src/db";
import { Alerter, type AlertSettings } from "../src/ops/alerts";
import { computeCallMetrics, metricBreaches, type RawConversation } from "../src/ops/callMetrics";
import { createApp } from "../src/server/app";
import { renderOpsIndex, renderOpsQuote } from "../src/server/ops";
import { QuoteService } from "../src/service";

// ISC-115 to ISC-117: per-call quality metrics from the ElevenLabs conversation record.

const NOW = new Date("2026-10-15T15:00:00Z"); // 11:00 New York, outside quiet hours
const WEBHOOK = "whsec_test_secret";
const fin = (s = 0.03) => ({ metrics: { convai_asr_trailing_service_latency: { elapsed_time: s } } });
const delay = (s: number) => ({ metrics: { convai_turn_silence_before_initiation: { elapsed_time: s } } });

/** Shaped like a real call: masked digits, the 2026-10-15 failure patterns, and a clean finish. */
const STALL_CALL: RawConversation = {
  metadata: { call_duration_secs: 121 },
  transcript: [
    { role: "agent", message: "Thanks for calling. What's your first and last name?", time_in_call_secs: 0 },
    { role: "user", message: "Max Harar.", time_in_call_secs: 6, conversation_turn_metrics: fin() },
    { role: "agent", message: "What's the ZIP code where the car is parked overnight?", time_in_call_secs: 8, conversation_turn_metrics: delay(0.3) },
    { role: "user", message: "...", time_in_call_secs: 14 },
    { role: "agent", message: "Sorry, I missed that. What's the ZIP?", time_in_call_secs: 15, conversation_turn_metrics: delay(0.4), interrupted: true },
    { role: "user", message: "One.", time_in_call_secs: 18, conversation_turn_metrics: fin() },
    { role: "agent", message: "Are you still there?", time_in_call_secs: 26, conversation_turn_metrics: delay(7.2) },
    { role: "user", message: "Yes.", time_in_call_secs: 28, conversation_turn_metrics: fin() },
    { role: "agent", message: "Let me read that back: one two three four. Is that right?", time_in_call_secs: 95, conversation_turn_metrics: delay(0.5) },
    // the stall: heard, stored, never finalized, then 9+ seconds of nothing
    { role: "user", message: "Yes. Yes.", time_in_call_secs: 104 },
  ],
};

const CLEAN_CALL: RawConversation = {
  metadata: { call_duration_secs: 60 },
  transcript: [
    { role: "agent", message: "What's your first and last name?", time_in_call_secs: 0 },
    { role: "user", message: "Sarah Smith.", time_in_call_secs: 4, conversation_turn_metrics: fin() },
    { role: "agent", message: "One moment while I run your price.", time_in_call_secs: 6, conversation_turn_metrics: delay(0.25), tool_calls: [{ tool_name: "get_quote" }] },
    { role: "user", message: "Okay.", time_in_call_secs: 20, conversation_turn_metrics: fin() },
    { role: "agent", message: "Thanks for calling!", time_in_call_secs: 22, conversation_turn_metrics: delay(0.3), tool_calls: [{ tool_name: "end_call" }] },
    // a caller turn after end_call is a hang-up artifact, not a stall
    { role: "user", message: "Bye", time_in_call_secs: 23 },
  ],
};

describe("computeCallMetrics", () => {
  test("counts the 2026-10-15 failure patterns", () => {
    expect(computeCallMetrics(STALL_CALL)).toEqual({
      caller_turns: 5,
      agent_turns: 5,
      empty_turns: 1,
      short_turns: 2,
      reasks: 2,
      unfinalized_turns: 1,
      stalls: 1,
      interruptions: 1,
      latency_p50: 0.5,
      latency_p90: 7.2,
      reached_quote: false,
    });
  });

  test("a clean call counts nothing bad, and a turn after end_call is not a stall", () => {
    const m = computeCallMetrics(CLEAN_CALL);
    expect(m).toMatchObject({ empty_turns: 0, reasks: 0, unfinalized_turns: 0, stalls: 0, interruptions: 0, reached_quote: true });
    expect(metricBreaches(m)).toEqual([]);
  });

  test("breaches name each threshold crossed", () => {
    expect(metricBreaches(computeCallMetrics(STALL_CALL))).toEqual(["1 caller turn(s) never finalized", "p90 response delay 7.2s"]);
    expect(metricBreaches({ ...computeCallMetrics(CLEAN_CALL), reasks: 3 })).toEqual(["3 re-asks"]);
  });
});

describe("post-call webhook stores metrics and warns on a bad live call", () => {
  const settings: AlertSettings = {
    disabled: false,
    telegram: { token: "tg-token", chatId: "42" },
    voice: { accountSid: "ACtest", authToken: "auth", from: "+10000000001", to: "+10000000002" },
    quietHours: [22, 7],
    telegramCooldownMs: 15 * 60_000,
    voiceCooldownMs: 2 * 3600_000,
    voiceDailyCap: 3,
  };
  const sign = (body: string, t = Math.floor(NOW.getTime() / 1000)) => `t=${t},v0=${createHmac("sha256", WEBHOOK).update(`${t}.${body}`).digest("hex")}`;

  function build(conv: RawConversation | null) {
    const repo = new Repo(openDb(":memory:"));
    const sent: string[] = [];
    const fetchImpl = (async (url: string | URL) => {
      sent.push(String(url));
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    const alerter = new Alerter(repo, settings, () => NOW, fetchImpl, () => {});
    const pending: Promise<unknown>[] = [];
    const app = createApp({
      repo,
      service: new QuoteService({ repo, now: () => NOW, decode: async () => ({ decoded: null, source: "timeout" }), licenseKey: "k" }),
      toolSecret: "test-secret-test-secret-123456",
      opsUser: "max",
      opsPassword: "pw-pw-pw-pw-pw",
      webhookSecrets: [WEBHOOK],
      alerter,
      now: () => NOW,
      fetchMeta: async () => null,
      fetchTranscript: async () => null,
      fetchRawConversation: async () => conv,
      onCallMetrics: (p) => pending.push(p),
      log: () => {},
    });
    return { repo, app, sent, settle: () => Promise.all(pending) };
  }

  const hook = (id: string, phone = true) =>
    JSON.stringify({
      type: "post_call_transcription",
      data: {
        conversation_id: id,
        agent_id: "agent_x",
        status: "done",
        metadata: { start_time_unix_secs: 1792040277, call_duration_secs: 121, termination_reason: "Call ended by remote party", ...(phone ? { phone_call: { type: "twilio", external_number: "+12155550188" } } : {}) },
        analysis: { call_successful: "success" },
      },
    });

  test("a live call that stalled stores its row and sends one Telegram warning, no phone call", async () => {
    const { app, repo, sent, settle } = build(STALL_CALL);
    const body = hook("conv_stall");
    expect((await app.request("/webhooks/elevenlabs", { method: "POST", headers: { "elevenlabs-signature": sign(body) }, body })).status).toBe(200);
    await settle();
    const row = repo.callMetrics("conv_stall")!;
    expect(row.is_test).toBe(0);
    expect(JSON.parse(row.metrics_json)).toMatchObject({ unfinalized_turns: 1, stalls: 1 });
    expect(JSON.stringify(row)).not.toContain("Harar"); // counts only, never transcript text
    expect(sent.filter((u) => u.includes("api.telegram.org")).length).toBe(1);
    expect(sent.some((u) => u.includes("twilio"))).toBe(false);
  });

  test("a test conversation stores metrics but never alerts", async () => {
    const { app, repo, sent, settle } = build(STALL_CALL);
    const body = hook("conv_ws_test", false);
    await app.request("/webhooks/elevenlabs", { method: "POST", headers: { "elevenlabs-signature": sign(body) }, body });
    await settle();
    expect(repo.callMetrics("conv_ws_test")!.is_test).toBe(1);
    expect(sent.length).toBe(0);
  });

  test("ElevenLabs being unreachable skips the row without failing the webhook", async () => {
    const { app, repo, settle } = build(null);
    const body = hook("conv_unreachable");
    expect((await app.request("/webhooks/elevenlabs", { method: "POST", headers: { "elevenlabs-signature": sign(body) }, body })).status).toBe(200);
    await settle();
    expect(repo.callMetrics("conv_unreachable")).toBeNull();
  });

  test("a live call where the caller declined recording alerts that a callback is owed (finding 6)", async () => {
    const { app, repo, sent, settle } = build(null);
    new QuoteService({ repo, now: () => NOW, licenseKey: "k" }).flagForHuman({ conversationId: "conv_declined", evalTag: "live", reason: "declined_recording", summary: "Declined." });
    const body = hook("conv_declined");
    await app.request("/webhooks/elevenlabs", { method: "POST", headers: { "elevenlabs-signature": sign(body) }, body });
    await settle();
    expect(sent.filter((u) => u.includes("api.telegram.org")).length).toBe(1);
    expect(repo.db.query<{ title: string }, []>("SELECT title FROM alerts").all().map((r) => r.title)).toContain("Callback owed: a caller declined recording and was promised a call back");
  });

  test("the ops console shows the call's quality card and the rolling summary", async () => {
    const { app, repo, settle } = build(STALL_CALL);
    const body = hook("conv_stall");
    await app.request("/webhooks/elevenlabs", { method: "POST", headers: { "elevenlabs-signature": sign(body) }, body });
    await settle();
    const detail = renderOpsQuote(repo, "conv_stall", { conversation: null })!;
    expect(detail).toContain("<h2>Call quality</h2>");
    expect(detail).toContain('<span class="warning">1</span>'); // never finalized, highlighted
    const index = renderOpsIndex(repo, {});
    expect(index).toContain("Call quality · last 1 live calls");
    expect(index).toContain("<td>1</td><td>5</td>");
  });
});

describe("review fixes: latency samples, callback alert, retention", () => {
  test("check-ins after silence or '...' don't count as agent response delay (finding 4)", () => {
    const fin = { metrics: { convai_asr_trailing_service_latency: { elapsed_time: 0.03 } } };
    const d = (s: number) => ({ metrics: { convai_turn_silence_before_initiation: { elapsed_time: s } } });
    const m = computeCallMetrics({
      transcript: [
        { role: "agent", message: "Do you have your license handy?", time_in_call_secs: 0 },
        { role: "user", message: "Let me grab my wallet.", time_in_call_secs: 3, conversation_turn_metrics: fin },
        { role: "agent", message: "No rush.", time_in_call_secs: 4, conversation_turn_metrics: d(0.3) },
        { role: "user", message: "...", time_in_call_secs: 8 },
        { role: "agent", message: "Take your time.", time_in_call_secs: 18, conversation_turn_metrics: d(10.2) },
        { role: "user", message: "...", time_in_call_secs: 22 },
        { role: "agent", message: "Whenever you're ready.", time_in_call_secs: 32, conversation_turn_metrics: d(10.1) },
      ],
    });
    expect(m.latency_p90).toBe(0.3);
    expect(metricBreaches(m)).toEqual([]);
  });

  test("retention covers call_metrics", async () => {
    const { runRetention } = await import("../src/ops/retention");
    const repo = new Repo(openDb(":memory:"));
    repo.saveCallMetrics("conv_old", false, { caller_turns: 1 });
    repo.db.exec("UPDATE call_metrics SET created_at = '2026-01-01T00:00:00.000Z'");
    repo.saveCallMetrics("conv_new", false, { caller_turns: 1 });
    const r = runRetention(repo.db, NOW, { mode: "enforce", liveDays: 30, evalDays: 7 });
    expect(r.callMetrics).toBe(1);
    expect(repo.callMetrics("conv_old")).toBeNull();
    expect(repo.callMetrics("conv_new")).not.toBeNull();
  });
});
