// Scoring for one audio-eval run: tool-call slots from the post-call conversation record
// (GET /v1/convai/conversations/{id}), plus live client-side utterance stats. Pure, unit tested.
// Digits are masked in everything stored or printed except the slot comparison booleans.

import type { Script } from "./scripts";

export const mask = (s: string) => s.replace(/\d/g, "#");

export const REASK_RE = /sorry,? i missed that|did i lose you|still there|didn'?t (catch|hear|get)|say that again|one more time/i;

export interface ToolCall {
  tool: string;
  params: Record<string, unknown>;
  t: number;
}

interface ConversationLike {
  transcript?: { role: string; message?: string | null; time_in_call_secs?: number; tool_calls?: { tool_name?: string; params_as_json?: string }[] | null }[];
}

export function extractToolCalls(conv: ConversationLike): ToolCall[] {
  const calls: ToolCall[] = [];
  for (const turn of conv.transcript ?? []) {
    for (const tc of turn.tool_calls ?? []) {
      if (!tc.tool_name) continue;
      let params: Record<string, unknown> = {};
      try {
        params = JSON.parse(tc.params_as_json || "{}");
      } catch {
        params = { _unparseable: true };
      }
      calls.push({ tool: tc.tool_name, params, t: turn.time_in_call_secs ?? 0 });
    }
  }
  return calls;
}

export function normalizeSlot(field: string, v: unknown): string {
  const s = String(v ?? "").trim();
  if (field === "license_number" || field === "vin") return s.replace(/\s+/g, "").toUpperCase();
  if (field === "make" || field === "model") return s.toLowerCase().replace(/[\s-]+/g, "");
  if (field === "zip") return s; // leading zeros matter (NJ)
  if (typeof v === "number" || /^-?\d+(\.\d+)?$/.test(s)) return String(Number(s));
  return s.toLowerCase().replace(/\s+/g, " ");
}

export interface SlotScore {
  /** "tool.field" -> exact match after normalization. */
  slots: Record<string, boolean>;
  missingTools: string[];
  forbiddenCalled: string[];
  taskSuccess: boolean;
  /** Masked actual values for failed slots (diagnosis without leaking digits). */
  mismatches: Record<string, string>;
}

export function scoreSlots(script: Script, calls: ToolCall[]): SlotScore {
  const slots: Record<string, boolean> = {};
  const mismatches: Record<string, string> = {};
  const missingTools: string[] = [];
  for (const [tool, want] of Object.entries(script.expected)) {
    // Re-saves replace: score the last call, for the same driver/vehicle index when one is expected.
    const index = want.driver_index ?? want.vehicle_index;
    const indexField = "driver_index" in want ? "driver_index" : "vehicle_index" in want ? "vehicle_index" : null;
    const last = calls.filter((c) => c.tool === tool && (indexField === null || Number(c.params[indexField]) === Number(index))).at(-1);
    if (!last) missingTools.push(tool);
    for (const [field, value] of Object.entries(want)) {
      const ok = !!last && normalizeSlot(field, last.params[field]) === normalizeSlot(field, value);
      slots[`${tool}.${field}`] = ok;
      if (!ok) mismatches[`${tool}.${field}`] = last ? mask(String(last.params[field] ?? "∅")) : "(tool not called)";
    }
  }
  const called = new Set(calls.map((c) => c.tool));
  const forbiddenCalled = script.forbidTools.filter((t) => called.has(t));
  const taskSuccess = !missingTools.length && !forbiddenCalled.length && Object.values(slots).every(Boolean);
  return { slots, missingTools, forbiddenCalled, taskSuccess, mismatches };
}

export function countReasks(conv: ConversationLike): number {
  return (conv.transcript ?? []).filter((t) => t.role === "agent" && t.message && REASK_RE.test(t.message)).length;
}

/** One time the caller spoke (a script line, a repeat, or a check-in reply). Times are ms since the WS opened. */
export interface Utterance {
  line: string;
  text: string;
  startedMs: number;
  endedMs: number | null;
  /** Masked user_transcript events attributed to this utterance. */
  transcripts: string[];
  /** ms from the end of this utterance to the first agent audio after it. */
  firstAgentAudioMs: number | null;
  /** No agent audio or response within 8 s of the utterance ending. */
  stalled: boolean;
  /** Agent audio arrived while the caller was still speaking. */
  agentTalkedDuring: boolean;
}

export const droppedCount = (u: Utterance[]) => u.filter((x) => x.transcripts.length === 0).length;

/** Nearest-rank percentile. */
export function percentile(xs: number[], p: number): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1))]!;
}
