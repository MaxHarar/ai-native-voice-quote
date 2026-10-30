// READ-ONLY baseline for the noise / quiet-voice plan. GET requests only. Never prints the API key.
// Run from the repo directory so Bun auto-loads .env:
//   bun scripts/noise-baseline.ts   (read-only GETs; writes noise-baseline.json to the working directory)
// Output: human-readable table on stdout + noise-baseline.json (aggregates + per-call rows, digits masked in all quoted text).
import { writeFileSync } from "node:fs";

const key = process.env.ELEVENLABS_API_KEY;
const agent = process.env.ELEVENLABS_AGENT_ID;
if (!key || !agent) throw new Error("missing ELEVENLABS_API_KEY / ELEVENLABS_AGENT_ID (run from the repo dir)");
const H = { "xi-api-key": key };
const BASE = "https://api.elevenlabs.io";
const OUT = process.env.NOISE_BASELINE_OUT ?? "noise-baseline.json";

async function get<T = any>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, { method: "GET", headers: H, signal: AbortSignal.timeout(30_000) });
  const text = await res.text();
  if (!res.ok) throw new Error(`GET ${path.split("?")[0]} -> HTTP ${res.status}`);
  return JSON.parse(text);
}

// ---------- helpers ----------
const mask = (s: string) => s.replace(/\d/g, "#");
const alnum = (s: string) => s.replace(/[^\p{L}\p{N}]/gu, "");
const words = (s: string) => mask(s).toLowerCase().replace(/[^\p{L}\p{N}#\s']/gu, " ").split(/\s+/).filter(Boolean);
const isEmptyOrDots = (m: string | null | undefined) => !m || !m.trim() || /^[\s.…·_-]+$/.test(m);
const ACK = new Set(["yes", "yep", "yup", "yeah", "no", "nah", "ok", "okay", "hi", "hey", "sir"]);
const jaccard = (a: string[], b: string[]) => {
  const A = new Set(a), B = new Set(b);
  if (!A.size || !B.size) return 0;
  let i = 0;
  for (const x of A) if (B.has(x)) i++;
  return i / (A.size + B.size - i);
};
const pct = (n: number, d: number) => (d ? `${((100 * n) / d).toFixed(1)}%` : "n/a");
const q = (arr: number[], p: number) => {
  if (!arr.length) return null;
  const s = [...arr].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))];
};

// Strict = the three phrases the task named. Extended = wider "I could not hear/understand" family.
const STRICT: Record<string, RegExp> = {
  sorry_i_missed_that: /sorry,?\s+i\s+missed\s+that/i,
  did_i_lose_you: /did\s+i\s+lose\s+you/i,
  still_there: /still\s+there/i,
};
const EXTENDED: Record<string, RegExp> = {
  didnt_catch_hear_get: /\b(didn'?t|did not|couldn'?t|could not)\s+(quite\s+)?(catch|hear|get)\b/i,
  say_repeat_again: /\b(say|repeat)\s+(that|it)\s+(again|one more time)|\bcould you (repeat|say)\b|\bone more time\b|\bcome again\b/i,
  cant_hear_bad_line: /\b(can'?t|cannot)\s+hear\b|\bhard to hear\b|\bbreaking up\b|\bbad (connection|line)\b|\bspeak up\b|\blouder\b/i,
  i_missed: /\bi\s+missed\b/i,
  // re-engagement check-ins that are not in the strict list but are the same family ("Are you still with me?")
  still_with_me_here: /still\s+(with me|here)\b/i,
};

// ---------- fetch ----------
type Row = Record<string, any>;
const conversations: Row[] = [];
let cursor: string | null = null;
for (let page = 0; page < 20; page++) {
  const r: any = await get(`/v1/convai/conversations?agent_id=${agent}&page_size=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
  conversations.push(...(r.conversations ?? []));
  cursor = r.next_cursor ?? null;
  if (!r.has_more || !cursor) break;
}
const bySource: Record<string, number> = {};
for (const c of conversations) bySource[c.conversation_initiation_source ?? "∅"] = (bySource[c.conversation_initiation_source ?? "∅"] ?? 0) + 1;
const phone = conversations.filter((c) => c.conversation_initiation_source === "twilio").sort((a, b) => a.start_time_unix_secs - b.start_time_unix_secs);

// ---------- per-call analysis ----------
const calls: Row[] = [];
const shortTexts: Record<string, number> = {};
const incidents: Row[] = [];
const dotsEvents: Row[] = [];
const dupes: Row[] = [];
const userAsrLatency: number[] = [];
const agentAsrLatency: number[] = [];
const agentAsrExcess: number[] = [];
const agentSilenceBefore: number[] = [];

// Per-call details are independent, so fetch them a few at a time (bounded to stay polite to the API), in order.
const CONCURRENCY = 8;
const details: any[] = new Array(phone.length);
let next = 0;
await Promise.all(
  Array.from({ length: Math.min(CONCURRENCY, phone.length) }, async () => {
    while (next < phone.length) {
      const i = next++;
      details[i] = await get(`/v1/convai/conversations/${phone[i]!.conversation_id}`);
    }
  }),
);

for (const [ci, c] of phone.entries()) {
  const d: any = details[ci];
  const md = d.metadata ?? {};
  const tr: any[] = d.transcript ?? [];
  const spoken = (t: any) => typeof t.message === "string" && t.message.trim().length > 0;
  const tools = new Set<string>();
  for (const t of tr) for (const tc of t.tool_calls ?? []) tools.add(tc.tool_name);

  const user = tr.filter((t) => t.role === "user");
  const agentSpoken = tr.filter((t) => t.role === "agent" && spoken(t));

  const emptyOrDots = user.filter((t) => isEmptyOrDots(t.message));
  const nonEmpty = user.filter((t) => !isEmptyOrDots(t.message));
  const veryShort = nonEmpty.filter((t) => alnum(t.message).length <= 3);
  const veryShortNonAck = veryShort.filter((t) => !ACK.has(alnum(t.message).toLowerCase()));
  for (const t of veryShort) {
    const k = mask(t.message.trim().toLowerCase());
    shortTexts[k] = (shortTexts[k] ?? 0) + 1;
  }
  const noAsrMetrics = user.filter((t) => !t.conversation_turn_metrics?.metrics?.convai_asr_trailing_service_latency);
  // an unfinalized caller turn that arrives AFTER the agent already ended/transferred the call is a hang-up artifact, not a stall
  const endedAt = Math.min(...tr.filter((t) => (t.tool_calls ?? []).some((x: any) => x.tool_name === "end_call" || x.tool_name === "transfer_to_number")).map((t) => t.time_in_call_secs as number), Infinity);
  const noAsrMetricsMidCall = noAsrMetrics.filter((t) => t.time_in_call_secs < endedAt);
  for (const t of user) {
    const v = t.conversation_turn_metrics?.metrics?.convai_asr_trailing_service_latency?.elapsed_time;
    if (typeof v === "number") userAsrLatency.push(v);
  }
  for (const t of tr.filter((x) => x.role === "agent")) {
    const m = t.conversation_turn_metrics?.metrics ?? {};
    if (typeof m.convai_turn_asr_latency?.elapsed_time === "number") agentAsrLatency.push(m.convai_turn_asr_latency.elapsed_time);
    if (typeof m.convai_turn_asr_excess?.elapsed_time === "number") agentAsrExcess.push(m.convai_turn_asr_excess.elapsed_time);
    if (typeof m.convai_turn_silence_before_initiation?.elapsed_time === "number") agentSilenceBefore.push(m.convai_turn_silence_before_initiation.elapsed_time);
  }

  // re-ask phrases in agent speech
  const strict: Record<string, number> = {};
  const ext: Record<string, number> = {};
  let strictTurns = 0, extTurns = 0;
  agentSpoken.forEach((t) => {
    let hitS = false, hitE = false;
    for (const [k, re] of Object.entries(STRICT)) if (re.test(t.message)) { strict[k] = (strict[k] ?? 0) + 1; hitS = true; }
    for (const [k, re] of Object.entries(EXTENDED)) if (re.test(t.message)) { ext[k] = (ext[k] ?? 0) + 1; hitE = true; }
    if (hitS) strictTurns++;
    if (hitE) extTurns++;
  });

  // incidents: re-ask turn + the preceding user turn (masked, short only)
  tr.forEach((t, i) => {
    if (t.role !== "agent" || !spoken(t)) return;
    const isReask = Object.values(STRICT).some((re) => re.test(t.message)) || Object.values(EXTENDED).some((re) => re.test(t.message));
    if (!isReask) return;
    const prevUser = [...tr.slice(0, i)].reverse().find((x) => x.role === "user");
    const uTxt = prevUser ? (isEmptyOrDots(prevUser.message) ? "<empty>" : mask(prevUser.message.trim())) : "<none>";
    incidents.push({
      call: c.conversation_id.slice(0, 12),
      t: Math.round(t.time_in_call_secs),
      prev_user: uTxt.split(/\s+/).length <= 8 ? uTxt : "<long utterance, withheld>",
      prev_user_had_asr_metrics: prevUser ? Boolean(prevUser.conversation_turn_metrics?.metrics?.convai_asr_trailing_service_latency) : null,
      agent: mask(t.message.trim()).slice(0, 110),
    });
  });

  // near-duplicate agent turns within a 3-turn window
  let dupCount = 0;
  agentSpoken.forEach((t, i) => {
    for (let j = Math.max(0, i - 3); j < i; j++) {
      if (jaccard(words(t.message), words(agentSpoken[j].message)) >= 0.7 && words(t.message).length >= 4) {
        dupCount++;
        dupes.push({ call: c.conversation_id.slice(0, 12), t: Math.round(t.time_in_call_secs), text: mask(t.message.trim()).slice(0, 110) });
        break;
      }
    }
  });

  // "..." placeholder turns: how soon after each one did the caller give a real answer? (collision with the timeout re-engagement)
  tr.forEach((t, i) => {
    if (t.role !== "user" || !isEmptyOrDots(t.message)) return;
    const nextReal = tr.slice(i + 1).find((x) => x.role === "user" && !isEmptyOrDots(x.message));
    const nextAgent = tr.slice(i + 1).find((x) => x.role === "agent" && spoken(x));
    dotsEvents.push({
      call: c.conversation_id.slice(0, 12),
      t: Math.round(t.time_in_call_secs),
      real_answer_after_s: nextReal ? Math.round((nextReal.time_in_call_secs - t.time_in_call_secs) * 10) / 10 : null,
      agent_checkin_after_s: nextAgent ? Math.round((nextAgent.time_in_call_secs - t.time_in_call_secs) * 10) / 10 : null,
      agent_checkin_interrupted: Boolean(nextAgent?.interrupted),
      silence_before_agent_turn_s: nextAgent?.conversation_turn_metrics?.metrics?.convai_turn_silence_before_initiation?.elapsed_time ?? null,
    });
  });

  // consecutive user turns with no agent speech between (turn split / agent not answering)
  let consecUser = 0;
  let lastRoleSpoken: string | null = null;
  for (const t of tr) {
    if (t.role === "user") {
      if (lastRoleSpoken === "user") consecUser++;
      lastRoleSpoken = "user";
    } else if (spoken(t)) lastRoleSpoken = "agent";
  }

  // stall signature (matches stall-scan.ts): last turn is the caller's, never finalized, call kept going >= 8s
  const items = tr.filter((t) => spoken(t) || t.tool_calls?.length);
  const last = items[items.length - 1];
  const dur = md.call_duration_secs ?? 0;
  const tailGap = last ? dur - last.time_in_call_secs : 0;
  const tailStall = Boolean(last && last.role === "user" && !last.conversation_turn_metrics?.metrics?.convai_asr_trailing_service_latency && tailGap >= 8);

  // mid-call dead air after an unfinalized user turn (>= 8s until next transcript item)
  let midStalls = 0;
  tr.forEach((t, i) => {
    if (t.role !== "user" || t.conversation_turn_metrics?.metrics?.convai_asr_trailing_service_latency) return;
    const next = tr.slice(i + 1).find((x) => spoken(x) || x.tool_calls?.length);
    if (next && next.time_in_call_secs - t.time_in_call_secs >= 8) midStalls++;
  });

  calls.push({
    id: c.conversation_id.slice(0, 12),
    start_et: new Date(md.start_time_unix_secs * 1000).toLocaleString("en-US", { timeZone: "America/New_York", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }),
    dur_s: Math.round(dur),
    termination: md.termination_reason ?? "?",
    status: d.status,
    call_successful: d.analysis?.call_successful,
    user_turns: user.length,
    agent_spoken_turns: agentSpoken.length,
    empty_or_dots: emptyOrDots.length,
    very_short: veryShort.length,
    very_short_non_ack: veryShortNonAck.length,
    no_asr_metrics: noAsrMetrics.length,
    no_asr_metrics_mid_call: noAsrMetricsMidCall.length,
    reached_get_quote: tools.has("get_quote"),
    reask_strict_turns: strictTurns,
    reask_strict: strict,
    reask_extended_turns: extTurns,
    reask_extended: ext,
    possible_repeat_agent_turns: dupCount,
    consecutive_user_turns: consecUser,
    agent_turns_interrupted: tr.filter((t) => t.role === "agent" && t.interrupted).length,
    user_ignored_as_backchannel: user.filter((t) => t.ignored_as_backchannel).length,
    tail_stall: tailStall,
    mid_call_stalls_ge8s: midStalls,
    last_item_role: last?.role ?? null,
    tail_gap_s: Math.round(tailGap),
    tools_called: [...tools].sort(),
    called_end_call: tools.has("end_call"),
    called_transfer: tools.has("transfer_to_number"),
    called_submit_application: tools.has("submit_application"),
    called_get_quote: tools.has("get_quote"),
    asr_model: md.charging?.asr_usage?.asr_model,
    asr_audio_input_s: md.charging?.asr_usage?.total_audio_input_seconds ? Math.round(md.charging.asr_usage.total_audio_input_seconds) : null,
    dtmf_input_enabled: md.features_usage?.dtmf_input?.enabled,
    dtmf_input_used: md.features_usage?.dtmf_input?.used,
    has_user_audio: d.has_user_audio,
  });
}

// ---------- aggregate ----------
const withSpeech = calls.filter((c) => c.user_turns > 0);
const sum = (k: string, rows = calls) => rows.reduce((a, r) => a + (r[k] ?? 0), 0);
const callsWith = (k: string, rows = calls) => rows.filter((r) => (r[k] ?? 0) > 0).length;
const U = sum("user_turns"), A = sum("agent_spoken_turns");
const termDist: Record<string, number> = {};
for (const c of calls) termDist[c.termination] = (termDist[c.termination] ?? 0) + 1;
const endBucket = (c: Row) =>
  c.user_turns === 0 ? "no caller speech (hang-up/abandon at greeting)" :
  c.called_transfer ? "agent transferred to human" :
  c.called_submit_application ? "application submitted" :
  c.called_end_call ? "agent ended call (no application)" :
  "caller hung up / dropped mid-flow";
const endDist: Record<string, number> = {};
for (const c of calls) endDist[endBucket(c)] = (endDist[endBucket(c)] ?? 0) + 1;

const agg = {
  generated_at: new Date().toISOString(),
  agent_conversations_total: conversations.length,
  by_source: bySource,
  phone_calls: calls.length,
  phone_calls_with_caller_speech: withSpeech.length,
  window_et: calls.length ? `${calls[0]!.start_et} → ${calls[calls.length - 1]!.start_et}` : null,
  user_turns: U,
  agent_spoken_turns: A,
  empty_or_dots_user_turns: { n: sum("empty_or_dots"), rate: pct(sum("empty_or_dots"), U), calls_affected: callsWith("empty_or_dots") },
  very_short_user_turns_le3_alnum: { n: sum("very_short"), rate: pct(sum("very_short"), U), calls_affected: callsWith("very_short") },
  very_short_excluding_yes_no_ok: { n: sum("very_short_non_ack"), rate: pct(sum("very_short_non_ack"), U), calls_affected: callsWith("very_short_non_ack") },
  user_turns_without_finalized_asr_metrics: { n: sum("no_asr_metrics"), rate: pct(sum("no_asr_metrics"), U), calls_affected: callsWith("no_asr_metrics"), of_which_mid_call_stall: sum("no_asr_metrics_mid_call"), of_which_after_end_call_artifact: sum("no_asr_metrics") - sum("no_asr_metrics_mid_call") },
  calls_that_reached_get_quote: callsWith("reached_get_quote"),
  calls_that_submitted_application: callsWith("called_submit_application"),
  agent_reask_strict_turns: { n: sum("reask_strict_turns"), rate_of_agent_turns: pct(sum("reask_strict_turns"), A), calls_affected: callsWith("reask_strict_turns"), per_phrase: (() => { const o: Record<string, number> = {}; for (const c of calls) for (const [k, v] of Object.entries(c.reask_strict)) o[k] = (o[k] ?? 0) + (v as number); return o; })() },
  agent_reask_extended_turns: { n: sum("reask_extended_turns"), rate_of_agent_turns: pct(sum("reask_extended_turns"), A), calls_affected: callsWith("reask_extended_turns"), per_phrase: (() => { const o: Record<string, number> = {}; for (const c of calls) for (const [k, v] of Object.entries(c.reask_extended)) o[k] = (o[k] ?? 0) + (v as number); return o; })() },
  possible_repeated_agent_turns_jaccard_ge_0_7: { n: sum("possible_repeat_agent_turns"), rate_of_agent_turns: pct(sum("possible_repeat_agent_turns"), A), calls_affected: callsWith("possible_repeat_agent_turns") },
  consecutive_user_turns_no_agent_between: { n: sum("consecutive_user_turns"), calls_affected: callsWith("consecutive_user_turns") },
  agent_turns_interrupted_by_caller: { n: sum("agent_turns_interrupted"), rate_of_agent_turns: pct(sum("agent_turns_interrupted"), A) },
  user_turns_ignored_as_backchannel: sum("user_ignored_as_backchannel"),
  tail_stalls: calls.filter((c) => c.tail_stall).length,
  mid_call_stalls_ge8s: sum("mid_call_stalls_ge8s"),
  termination_reasons: termDist,
  how_calls_ended: endDist,
  latency_s: {
    user_asr_trailing_service_latency: { n: userAsrLatency.length, p50: q(userAsrLatency, 0.5), p90: q(userAsrLatency, 0.9), max: q(userAsrLatency, 1) },
    agent_turn_asr_latency: { n: agentAsrLatency.length, p50: q(agentAsrLatency, 0.5), p90: q(agentAsrLatency, 0.9) },
    agent_turn_asr_excess: { n: agentAsrExcess.length, p50: q(agentAsrExcess, 0.5), p90: q(agentAsrExcess, 0.9) },
    agent_turn_silence_before_initiation: { n: agentSilenceBefore.length, p50: q(agentSilenceBefore, 0.5), p90: q(agentSilenceBefore, 0.9), max: q(agentSilenceBefore, 1) },
  },
  dtmf_input_enabled_on_calls: calls.filter((c) => c.dtmf_input_enabled).length,
  dtmf_input_used_on_calls: calls.filter((c) => c.dtmf_input_used).length,
  short_user_text_histogram: Object.fromEntries(Object.entries(shortTexts).sort((a, b) => b[1] - a[1]).slice(0, 25)),
};

// config era: which phone calls ran under the CURRENT deployed turn settings (agent/deployed.json, read from cwd = repo dir)
let deployedAt: string | null = null;
try {
  deployedAt = JSON.parse(await Bun.file("agent/deployed.json").text()).deployed_at ?? null;
} catch {}
const deployedMs = deployedAt ? Date.parse(deployedAt) : NaN;
(agg as Row).current_config_deployed_at = deployedAt;
(agg as Row).phone_calls_started_after_current_deploy = phone.filter((c) => c.start_time_unix_secs * 1000 >= deployedMs).length;
(agg as Row).dots_events = {
  n: dotsEvents.length,
  real_answer_within_5s: dotsEvents.filter((e) => e.real_answer_after_s !== null && e.real_answer_after_s <= 5).length,
  agent_checkin_interrupted: dotsEvents.filter((e) => e.agent_checkin_interrupted).length,
  silence_before_agent_turn_s_range: [Math.min(...dotsEvents.map((e) => e.silence_before_agent_turn_s ?? Infinity)), Math.max(...dotsEvents.map((e) => e.silence_before_agent_turn_s ?? 0))].map((v) => Math.round(v * 10) / 10),
};

writeFileSync(OUT, JSON.stringify({ aggregates: agg, calls, dots_events: dotsEvents, incidents, possible_repeats: dupes }, null, 2));

// ---------- print ----------
console.log("=== PER CALL (twilio) ===");
console.table(calls.map((c) => ({ id: c.id, start_et: c.start_et, dur: c.dur_s, user: c.user_turns, agent: c.agent_spoken_turns, empty: c.empty_or_dots, short: c.very_short, noASR: c.no_asr_metrics, reaskS: c.reask_strict_turns, reaskE: c.reask_extended_turns, rep: c.possible_repeat_agent_turns, intr: c.agent_turns_interrupted, stall: c.tail_stall ? "TAIL" : c.mid_call_stalls_ge8s ? `mid${c.mid_call_stalls_ge8s}` : "", end: endBucket(c).slice(0, 28) })));
console.log("\n=== AGGREGATES ===");
console.log(JSON.stringify(agg, null, 2));
console.log("\n=== '...' PLACEHOLDER USER TURNS ===");
for (const e of dotsEvents) console.log(JSON.stringify(e));
console.log("\n=== RE-ASK INCIDENTS (digits masked; long utterances withheld) ===");
for (const i of incidents) console.log(JSON.stringify(i));
console.log("\n=== POSSIBLE REPEATED AGENT TURNS ===");
for (const i of dupes) console.log(JSON.stringify(i));
console.log(`\nwrote ${OUT}`);
