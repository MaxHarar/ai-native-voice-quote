// Per-call conversation-quality metrics, computed from the ElevenLabs conversation record after each call.
// Same definitions as scripts/noise-baseline.ts, so a live row and a baseline run are comparable. Only
// counts and timings are stored: no transcript text leaves ElevenLabs' 30-day retention window.

export interface CallMetrics {
  caller_turns: number;
  agent_turns: number;
  /** Caller turns that came through empty or as "..." (speech the platform heard but couldn't transcribe). */
  empty_turns: number;
  /** Caller turns of 3 or fewer letters/digits ("No.", "One."): the class that gets dropped. */
  short_turns: number;
  /** Agent turns that ask the caller to repeat or check whether they're still there. */
  reasks: number;
  /** Caller turns the platform never finalized, before the call ended (the "Yes. Yes." stall class). */
  unfinalized_turns: number;
  /** Unfinalized caller turns followed by 8+ seconds of nothing (dead air). */
  stalls: number;
  /** Agent turns the caller cut off. */
  interruptions: number;
  /** Silence before the agent starts speaking after a finalized caller answer, in seconds. */
  latency_p50: number | null;
  latency_p90: number | null;
  reached_quote: boolean;
}

/** Thresholds for a live-call warning (ISC-117). */
export const METRIC_ALERTS = { unfinalizedTurns: 1, reasks: 3, latencyP90Secs: 3 } as const;

const REASK =
  /sorry,?\s+i\s+missed\s+that|did\s+i\s+lose\s+you|still\s+(there|with me)\b|\b(didn'?t|did not|couldn'?t|could not)\s+(quite\s+)?(catch|hear|get)\b|\b(say|repeat)\s+(that|it)\s+(again|one more time)|\bone more time\b|\bcome again\b/i;
const isEmpty = (m: unknown) => typeof m !== "string" || !m.trim() || /^[\s.…·_-]+$/.test(m);
const alnumLen = (m: string) => m.replace(/[^\p{L}\p{N}]/gu, "").length;
const spoken = (t: RawTurn) => typeof t.message === "string" && t.message.trim().length > 0;
const finalized = (t: RawTurn) => typeof t.conversation_turn_metrics?.metrics?.convai_asr_trailing_service_latency?.elapsed_time === "number";

export function quantile(xs: number[], p: number): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return Math.round(s[Math.min(s.length - 1, Math.floor(p * s.length))]! * 100) / 100;
}

interface RawTurn {
  role: string;
  message?: string | null;
  time_in_call_secs?: number;
  interrupted?: boolean;
  tool_calls?: { tool_name: string }[] | null;
  conversation_turn_metrics?: { metrics?: Record<string, { elapsed_time?: number }> } | null;
}

export interface RawConversation {
  transcript?: RawTurn[];
  metadata?: { call_duration_secs?: number };
}

export function computeCallMetrics(conv: RawConversation): CallMetrics {
  const tr = conv.transcript ?? [];
  const user = tr.filter((t) => t.role === "user");
  const agent = tr.filter((t) => t.role === "agent" && spoken(t));
  const tools = tr.flatMap((t) => (t.tool_calls ?? []).map((c) => c.tool_name));
  // A caller turn that lands after the agent ended or transferred the call is a hang-up artifact, not a stall.
  const endedAt = Math.min(
    ...tr.filter((t) => (t.tool_calls ?? []).some((c) => c.tool_name === "end_call" || c.tool_name === "transfer_to_number")).map((t) => t.time_in_call_secs ?? Infinity),
    Infinity,
  );
  const unfinalized = user.filter((t) => !isEmpty(t.message) && !finalized(t) && (t.time_in_call_secs ?? 0) < endedAt);
  let stalls = 0;
  tr.forEach((t, i) => {
    if (t.role !== "user" || isEmpty(t.message) || finalized(t) || (t.time_in_call_secs ?? 0) >= endedAt) return;
    const next = tr.slice(i + 1).find((x) => spoken(x) || x.tool_calls?.length);
    const gap = next ? (next.time_in_call_secs ?? 0) - (t.time_in_call_secs ?? 0) : (conv.metadata?.call_duration_secs ?? 0) - (t.time_in_call_secs ?? 0);
    if (gap >= 8) stalls++;
  });
  // Response delay only after a real, finalized caller answer: a check-in after silence or "..." is the turn timeout
  // working as designed ("No rush" waits), not the agent being slow.
  const latency: number[] = [];
  let lastUser: RawTurn | null = null;
  for (const t of tr) {
    if (t.role === "user") lastUser = t;
    else if (t.role === "agent") {
      const v = t.conversation_turn_metrics?.metrics?.convai_turn_silence_before_initiation?.elapsed_time;
      if (typeof v === "number" && lastUser && !isEmpty(lastUser.message) && finalized(lastUser)) latency.push(v);
    }
  }
  return {
    caller_turns: user.length,
    agent_turns: agent.length,
    empty_turns: user.filter((t) => isEmpty(t.message)).length,
    short_turns: user.filter((t) => !isEmpty(t.message) && alnumLen(t.message!) <= 3).length,
    reasks: agent.filter((t) => REASK.test(t.message!)).length,
    unfinalized_turns: unfinalized.length,
    stalls,
    interruptions: agent.filter((t) => t.interrupted).length,
    latency_p50: quantile(latency, 0.5),
    latency_p90: quantile(latency, 0.9),
    reached_quote: tools.includes("get_quote"),
  };
}

/** Which thresholds a call breached; empty when it's clean. */
export function metricBreaches(m: CallMetrics): string[] {
  return [
    m.unfinalized_turns >= METRIC_ALERTS.unfinalizedTurns && `${m.unfinalized_turns} caller turn(s) never finalized`,
    m.reasks >= METRIC_ALERTS.reasks && `${m.reasks} re-asks`,
    m.latency_p90 !== null && m.latency_p90 > METRIC_ALERTS.latencyP90Secs && `p90 response delay ${m.latency_p90}s`,
  ].filter((x): x is string => Boolean(x));
}

export async function fetchRawConversation(conversationId: string, apiKey: string | undefined, fetchImpl: typeof fetch = fetch): Promise<RawConversation | null> {
  if (!apiKey) return null;
  const res = await fetchImpl(`https://api.elevenlabs.io/v1/convai/conversations/${encodeURIComponent(conversationId)}`, {
    headers: { "xi-api-key": apiKey },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) return null;
  return (await res.json()) as RawConversation;
}
