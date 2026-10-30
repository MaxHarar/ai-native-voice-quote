// Turn-driven caller logic: given what the agent just said, decide which script line to speak.
// Pure and unit tested; the WebSocket session calls decide() each time the agent finishes a turn.

export interface Line {
  id: string;
  /** What the caller says, written as spoken words (no digits: TTS reads digits inconsistently). */
  say: string;
  /** The agent's latest turn must match this before the line is spoken. */
  when: RegExp;
  /** Never answer with this line when the agent's turn also matches this. */
  unless?: RegExp;
  /** The agent may legitimately never ask this; dropped silently when a later line is answered. */
  optional?: boolean;
}

export type Decision =
  | { kind: "say"; index: number; skipped: number[] }
  | { kind: "repeat"; index: number }
  | { kind: "checkin" }
  | { kind: "none" };

export const CHECKIN_RE = /did i lose you|still there|are you there|still with me|you there\?/i;

const fits = (line: Line, text: string) => line.when.test(text) && !line.unless?.test(text);

/**
 * pending: indices of lines not yet said, in script order. lastSaid: the line spoken last.
 * Order of precedence: a pending line within the lookahead window, then a re-ask of the line
 * just said, then a bare check-in, else nothing (keep listening).
 */
export function decide(lines: Line[], pending: number[], lastSaid: number | null, agentText: string, window = 4): Decision {
  const head = pending.slice(0, window);
  for (let p = 0; p < head.length; p++) {
    const index = head[p]!;
    if (!fits(lines[index]!, agentText)) continue;
    const skipped = head.slice(0, p).filter((i) => lines[i]!.optional);
    return { kind: "say", index, skipped };
  }
  if (lastSaid !== null && fits(lines[lastSaid]!, agentText)) return { kind: "repeat", index: lastSaid };
  if (CHECKIN_RE.test(agentText)) return { kind: "checkin" };
  return { kind: "none" };
}
