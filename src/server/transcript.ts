// Conversation view for the ops console: fetched live from ElevenLabs when an operator opens a call,
// never copied into our database (ElevenLabs retains transcripts for the agent's 30-day window).
// License-number-like digit runs are masked even here.

export interface TranscriptTurn {
  role: "agent" | "user";
  message: string;
  secs: number;
  tools: { name: string; args: string }[];
  results: { name: string; ok: boolean; latencyMs: number | null; summary: string }[];
}

export interface Conversation {
  status: string | null;
  durationSecs: number | null;
  turns: TranscriptTurn[];
  hasAudio: boolean;
  /** ElevenLabs timed out or errored (not a 404): the call may still exist, so the page says "retry", not "gone". */
  unavailable?: boolean;
}

const DIGIT_WORDS: Record<string, string> = { zero: "0", oh: "0", one: "1", two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7", eight: "8", nine: "9" };
// Spoken digits that aren't part of a longer word ("someone", "phone" and "none" contain "one").
const WORD_DIGIT = "(?<![a-z])(?:zero|oh|one|two|three|four|five|six|seven|eight|nine)(?![a-z])";
const MASKS = [
  // 7+ numerals with at most one space or hyphen between them: "S10000000000001", "215-620-4887".
  /\d(?:[\s-]?\d){6,}/g,
  // Read-back groups of 3-4 numerals split by commas: "1000, 0000, 0000, 0001". "ZIP 08540, 24 months" stays readable.
  /\b\d{3,4}(?:,[ \t]*\d{3,4}){2,}\b/g,
  // 7+ spoken digits, as the agent reads a license back: "one zero zero zero, zero zero zero zero, ...".
  new RegExp(`${WORD_DIGIT}(?:(?:,?[ \\t]*|-)${WORD_DIGIT}){6,}`, "gi"),
];

/**
 * Masks runs of 7+ digits (license numbers, phone numbers) down to their last 4, including numbers the
 * agent read back as words: the license read-back would otherwise land in the transcript in clear text.
 */
export function maskDigits(s: string): string {
  return MASKS.reduce(
    (out, re) =>
      out.replace(re, (run) => {
        const digits = (run.match(/\d|zero|oh|one|two|three|four|five|six|seven|eight|nine/gi) ?? []).map((t) => DIGIT_WORDS[t.toLowerCase()] ?? t);
        return "•".repeat(Math.max(0, digits.length - 4)) + digits.slice(-4).join("");
      }),
    s,
  );
}

/** A tool can fail two ways: the platform flags an error, or our server answers ok:false (a rejected value). */
function resultFailed(isError: boolean | undefined, raw: unknown): boolean {
  if (isError) return true;
  try {
    const v = typeof raw === "string" ? JSON.parse(raw) : raw;
    return !!v && typeof v === "object" && (v as Record<string, unknown>).ok === false;
  } catch {
    return false;
  }
}

function summarize(raw: unknown): string {
  try {
    const v = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (v && typeof v === "object") {
      const o = v as Record<string, unknown>;
      if (o.ok === false) return `${o.error ?? "error"}`;
      const keys = ["six_month_premium", "application_number", "eligibility", "vehicle", "state", "tort_option", "package"].filter((k) => o[k] !== undefined);
      return keys.length ? keys.map((k) => `${k}=${o[k]}`).join(" · ") : "ok";
    }
    return String(v).slice(0, 80);
  } catch {
    return String(raw).slice(0, 80);
  }
}

export async function fetchConversation(conversationId: string, apiKey: string | undefined, fetchImpl: typeof fetch = fetch): Promise<Conversation | null> {
  if (!apiKey || !conversationId.startsWith("conv_")) return null;
  try {
    const res = await fetchImpl(`https://api.elevenlabs.io/v1/convai/conversations/${encodeURIComponent(conversationId)}`, {
      headers: { "xi-api-key": apiKey },
      signal: AbortSignal.timeout(4000),
    });
    if (res.status === 404) return null;
    if (!res.ok) return UNAVAILABLE;
    const j = (await res.json()) as {
      status?: string;
      has_audio?: boolean;
      metadata?: { call_duration_secs?: number };
      transcript?: {
        role: "agent" | "user";
        message: string | null;
        time_in_call_secs?: number;
        tool_calls?: { tool_name?: string; params_as_json?: string }[];
        tool_results?: { tool_name?: string; is_error?: boolean; tool_latency_secs?: number; result_value?: string }[];
      }[];
    };
    const turns: TranscriptTurn[] = (j.transcript ?? []).map((t) => ({
      role: t.role,
      message: maskDigits(t.message ?? ""),
      secs: t.time_in_call_secs ?? 0,
      tools: (t.tool_calls ?? []).map((c) => ({ name: c.tool_name ?? "tool", args: maskDigits(compactArgs(c.params_as_json)) })),
      results: (t.tool_results ?? []).map((r) => ({
        name: r.tool_name ?? "tool",
        ok: !resultFailed(r.is_error, r.result_value),
        latencyMs: r.tool_latency_secs !== undefined ? Math.round(r.tool_latency_secs * 1000) : null,
        summary: maskDigits(summarize(r.result_value)),
      })),
    }));
    return { status: j.status ?? null, durationSecs: j.metadata?.call_duration_secs ?? null, turns, hasAudio: !!j.has_audio };
  } catch {
    return UNAVAILABLE;
  }
}

const UNAVAILABLE: Conversation = { status: null, durationSecs: null, turns: [], hasAudio: false, unavailable: true };

/** Tool args minus session plumbing, as a short `k=v` list. */
function compactArgs(json: string | undefined): string {
  try {
    const o = JSON.parse(json ?? "{}") as Record<string, unknown>;
    delete o.conversation_id;
    delete o.eval_tag;
    return Object.entries(o)
      .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
      .join(", ");
  } catch {
    return "";
  }
}

/** Streams call audio from ElevenLabs (operators only; nothing is stored). */
export async function fetchAudio(conversationId: string, apiKey: string | undefined, fetchImpl: typeof fetch = fetch): Promise<Response | null> {
  if (!apiKey || !conversationId.startsWith("conv_")) return null;
  const res = await fetchImpl(`https://api.elevenlabs.io/v1/convai/conversations/${encodeURIComponent(conversationId)}/audio`, {
    headers: { "xi-api-key": apiKey },
    signal: AbortSignal.timeout(15000),
  }).catch(() => null);
  return res && res.ok ? res : null;
}
