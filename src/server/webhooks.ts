import { createHmac, timingSafeEqual } from "node:crypto";
import type { Repo } from "../db";
import type { Alerter } from "../ops/alerts";
import { computeCallMetrics, metricBreaches, type CallMetrics, type RawConversation } from "../ops/callMetrics";

// ElevenLabs post-call webhooks: HMAC-verified call outcomes (status, duration, termination reason,
// LLM evaluation results). Transcripts are excluded at the source (exclude_transcript) — the server
// keeps outcomes, not conversations. Live phone-call failures and policy-check failures alert.

export const SIGNATURE_TOLERANCE_SECS = 30 * 60;

/** Verifies `ElevenLabs-Signature: t=<unix>,v0=<hex hmac-sha256(secret, "<t>.<rawBody>")>` against any active secret. */
export function verifySignature(header: string | undefined, rawBody: string, secrets: string[], nowSecs: number): { ok: true } | { ok: false; reason: string } {
  if (!header) return { ok: false, reason: "missing signature" };
  const parts = Object.fromEntries(header.split(",").map((p) => p.trim().split("=", 2) as [string, string]));
  const t = Number(parts.t);
  const v0 = parts.v0;
  if (!t || !v0) return { ok: false, reason: "malformed signature" };
  if (Math.abs(nowSecs - t) > SIGNATURE_TOLERANCE_SECS) return { ok: false, reason: "stale timestamp" };
  const given = Buffer.from(v0, "hex");
  for (const secret of secrets) {
    const expected = createHmac("sha256", secret).update(`${t}.${rawBody}`).digest();
    if (given.length === expected.length && timingSafeEqual(given, expected)) return { ok: true };
  }
  return { ok: false, reason: "bad signature" };
}

/** Evaluation criteria whose failure on a live call is a compliance problem (Telegram warning). */
export const SAFETY_CRITERIA = ["no_prohibited_questions", "no_binding_claims", "confirmed_before_submit"];

interface PostCallData {
  conversation_id: string;
  agent_id?: string;
  status?: string;
  failure_reason?: string;
  metadata?: {
    start_time_unix_secs?: number;
    call_duration_secs?: number;
    termination_reason?: string;
    error?: { reason?: string } | null;
    phone_call?: { type?: string; external_number?: string; direction?: string } | null;
    conversation_initiation_source?: string;
    cost?: number;
    type?: string;
  };
  analysis?: { call_successful?: string; evaluation_criteria_results?: Record<string, { result?: string }> };
  conversation_initiation_client_data?: { dynamic_variables?: Record<string, unknown> };
}

export interface WebhookOutcome {
  kind: "call" | "initiation_failure" | "ignored";
  isTest: boolean;
  alerts: string[];
}

export async function handleWebhook(
  event: { type?: string; data?: PostCallData },
  repo: Repo,
  alerter: Alerter,
  baseUrl: string,
  attachCaller: (conversationId: string, phone: string) => void = (id, phone) => repo.setCallerPhone(id, phone),
): Promise<WebhookOutcome> {
  const d = event.data;
  if (!d?.conversation_id || (event.type !== "post_call_transcription" && event.type !== "call_initiation_failure")) {
    return { kind: "ignored", isTest: true, alerts: [] };
  }
  const m = d.metadata ?? {};
  const isPhone = m.phone_call?.type === "twilio" || m.conversation_initiation_source === "twilio" || m.type === "twilio";
  // Evals (sim_ ids), canaries (WebSocket) and any non-phone conversation never page anyone.
  const isTest = d.conversation_id.startsWith("sim_") || d.conversation_initiation_client_data?.dynamic_variables?.canary === "true" || !isPhone;
  const alerts: string[] = [];
  const opsLink = `${baseUrl}/ops/quote/${encodeURIComponent(d.conversation_id)}`;

  if (event.type === "call_initiation_failure") {
    repo.upsertCall({
      conversation_id: d.conversation_id, agent_id: d.agent_id ?? null, kind: "initiation_failure", status: "initiation_failed", is_test: isTest ? 1 : 0,
      source: m.type ?? null, started_at: null, duration_secs: 0, termination_reason: null, error: d.failure_reason ?? "unknown", caller_phone: null,
      call_successful: "failure", evaluation_json: null, cost: null,
    });
    if (!isTest) {
      const busy = d.failure_reason === "busy" || d.failure_reason === "no-answer";
      await alerter.send({ key: `initiation_failure:${d.failure_reason ?? "unknown"}`, severity: busy ? "warning" : "critical", title: `A call failed to connect (${d.failure_reason ?? "unknown"})`, detail: opsLink });
      alerts.push("initiation_failure");
    }
    return { kind: "initiation_failure", isTest, alerts };
  }

  const evaluation = d.analysis?.evaluation_criteria_results ?? {};
  repo.upsertCall({
    conversation_id: d.conversation_id, agent_id: d.agent_id ?? null, kind: "call", status: d.status ?? null, is_test: isTest ? 1 : 0,
    source: m.conversation_initiation_source ?? m.phone_call?.type ?? null,
    started_at: m.start_time_unix_secs ? new Date(m.start_time_unix_secs * 1000).toISOString() : null,
    duration_secs: m.call_duration_secs ?? null, termination_reason: m.termination_reason ?? null, error: m.error?.reason ?? null,
    caller_phone: m.phone_call?.external_number ?? null, call_successful: d.analysis?.call_successful ?? null,
    evaluation_json: Object.keys(evaluation).length ? JSON.stringify(Object.fromEntries(Object.entries(evaluation).map(([k, v]) => [k, v.result ?? null]))) : null,
    cost: m.cost ?? null,
  });
  if (m.phone_call?.external_number && !isTest) attachCaller(d.conversation_id, m.phone_call.external_number);

  if (!isTest) {
    if (d.status === "failed" || m.error?.reason) {
      await alerter.send({ key: `call_failed:${(m.error?.reason ?? d.status ?? "").slice(0, 60)}`, severity: "critical", title: `A live call failed: ${m.error?.reason ?? d.status}`, detail: opsLink });
      alerts.push("call_failed");
    }
    // A caller who declined recording was promised a callback; make sure a person hears about it.
    if (repo.getQuote(d.conversation_id)?.transfer_reason === "declined_recording") {
      await alerter.send({ key: `callback:${d.conversation_id}`, severity: "warning", title: "Callback owed: a caller declined recording and was promised a call back", detail: opsLink });
      alerts.push("callback");
    }
    const failedSafety = SAFETY_CRITERIA.filter((c) => evaluation[c]?.result === "failure");
    if (failedSafety.length) {
      await alerter.send({ key: `policy:${failedSafety.join(",")}`, severity: "warning", title: `Policy check failed on a live call: ${failedSafety.join(", ")}`, detail: opsLink });
      alerts.push("policy");
    }
  }
  return { kind: "call", isTest, alerts };
}

/**
 * After a call: pull the conversation from ElevenLabs, store its quality counts, and warn when a live call
 * breached a threshold. Runs off the webhook's response path; any failure only skips the row.
 */
export async function collectCallMetrics(
  conversationId: string,
  isTest: boolean,
  repo: Repo,
  alerter: Alerter,
  baseUrl: string,
  fetchConversation: (id: string) => Promise<RawConversation | null>,
): Promise<{ metrics: CallMetrics | null; breaches: string[] }> {
  const conv = await fetchConversation(conversationId).catch(() => null);
  if (!conv?.transcript) return { metrics: null, breaches: [] };
  const metrics = computeCallMetrics(conv);
  repo.saveCallMetrics(conversationId, isTest, metrics);
  const breaches = isTest ? [] : metricBreaches(metrics);
  if (breaches.length) {
    await alerter.send({
      key: `call_quality:${breaches.map((b) => b.replace(/[\d.]+/g, "N")).join(",")}`,
      severity: "warning",
      title: `Call quality on a live call: ${breaches.join("; ")}`,
      detail: `${baseUrl}/ops/quote/${encodeURIComponent(conversationId)}`,
    });
  }
  return { metrics, breaches };
}
