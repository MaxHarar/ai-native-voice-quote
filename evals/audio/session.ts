// One audio conversation with the deployed agent over the ElevenLabs Agent WebSocket.
//
// The "microphone" streams continuously in real time (one chunk every chunkMs), like a phone
// line: speech clips when the caller talks, otherwise silence or the noise bed. The caller
// waits for the agent to finish (playout of received audio drained, plus agent_response or
// 1.2 s of no new audio), then decide() picks the line that answers what the agent asked.

import { chunkSamples, fromBytes, RATE, toBytes } from "./audio";
import { decide, type Line } from "./match";
import { CHECKIN_REPLY } from "./scripts";
import { mask, type Utterance } from "./score";

export interface SessionInput {
  signedUrl: string;
  lines: Line[];
  /** Processed clip per line index. */
  clips: Int16Array[];
  checkinClip: Int16Array;
  bed: Int16Array | null;
  chunkMs?: number;
  log?: (s: string) => void;
}

export interface SessionResult {
  conversationId: string | null;
  userInputFormat: string | null;
  agentOutputFormat: string | null;
  utterances: Utterance[];
  agentTurns: { ms: number; text: string }[];
  unsaidRequired: string[];
  desync: string | null;
  endReason: string;
  interruptions: number;
  closeCode: number | null;
  durationMs: number;
}

// Timing knobs (ms).
export const TIMING = {
  doneSilence: 1200, // no new agent audio for this long = agent finished its turn
  drainPad: 250, // margin after playout of received audio would end
  reaction: 600, // human gap before answering
  stall: 8000, // no agent audio/response within this long after a caller line = stall
  silentRepeat: 15000, // caller repeats itself after this much agent silence
  deadAir: 30000, // nobody talking for this long while the script is unfinished = desync
  closeWait: 20000, // after the last line, wait this long for the agent to end the call
  firstMessage: 20000,
  run: 12 * 60_000,
};
const MAX_UNMATCHED = 4;
const MAX_REPEATS = 3;
const MAX_CHECKINS = 2;

interface Spoken {
  clip: Int16Array;
  line: string;
  text: string;
  index: number | null;
}

export function runSession(input: SessionInput): Promise<SessionResult> {
  const chunkMs = input.chunkMs ?? 80;
  const CH = chunkSamples(chunkMs);
  const log = input.log ?? (() => {});
  const { lines } = input;
  const started = performance.now();
  const now = () => performance.now() - started;

  const r: SessionResult = {
    conversationId: null, userInputFormat: null, agentOutputFormat: null, utterances: [], agentTurns: [],
    unsaidRequired: [], desync: null, endReason: "", interruptions: 0, closeCode: null, durationMs: 0,
  };

  // agent side
  let playbackEnd = 0;
  let lastAudioAt = -1;
  let lastActivityAt = -1;
  let heard = false; // agent audio since the last decision
  let responded = false; // agent_response since the last decision
  let agentText = ""; // agent text since the caller last spoke

  // caller side
  let pending = lines.map((_, i) => i);
  let lastSaid: number | null = null;
  let lastSpoken: Spoken | null = null;
  let speaking: { pcm: Int16Array; pos: number; utt: Utterance } | null = null;
  let chosen: Spoken | null = null;
  let reactAt: number | null = null;
  let decidedAt = 0;
  let unmatched = 0;
  let checkins = 0;
  let silentRepeats = 0;
  const repeats = new Map<number, number>();
  let closed = false;
  let stop = false;
  let timer: ReturnType<typeof setInterval> | undefined;

  const requiredLeft = () => pending.some((i) => !lines[i]!.optional);
  const lastUtt = () => r.utterances.at(-1);

  return new Promise<SessionResult>((resolve) => {
    const ws = new WebSocket(input.signedUrl);
    const send = (o: unknown) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(o));
    };

    const finish = (endReason: string, desync: string | null = null) => {
      if (stop) return;
      stop = true;
      clearInterval(timer);
      r.endReason = endReason;
      r.desync = desync;
      r.unsaidRequired = pending.filter((i) => !lines[i]!.optional).map((i) => lines[i]!.id);
      r.durationMs = Math.round(now());
      if (ws.readyState === WebSocket.OPEN) ws.close(1000, "eval done");
      setTimeout(() => resolve(r), 300);
    };

    // ---------- microphone: real-time paced chunks, drift-corrected ----------
    const mic = async () => {
      const t0 = performance.now();
      let bedPos = 0;
      for (let n = 0; !stop && !closed; n++) {
        const wait = t0 + n * chunkMs - performance.now();
        if (wait > 0) await Bun.sleep(wait);
        const out = new Int16Array(CH);
        let filled = 0;
        let ended: Utterance | null = null;
        if (speaking) {
          const take = Math.min(CH, speaking.pcm.length - speaking.pos);
          out.set(speaking.pcm.subarray(speaking.pos, speaking.pos + take));
          speaking.pos += take;
          filled = take;
          if (speaking.pos >= speaking.pcm.length) {
            ended = speaking.utt;
            speaking = null;
          }
        }
        if (input.bed) for (let i = filled; i < CH; i++) out[i] = input.bed[(bedPos + i) % input.bed.length]!;
        bedPos += CH;
        send({ user_audio_chunk: Buffer.from(toBytes(out)).toString("base64") });
        if (ended) ended.endedMs = Math.round(now());
      }
    };

    const speak = (s: Spoken) => {
      const utt: Utterance = { line: s.line, text: s.text, startedMs: Math.round(now()), endedMs: null, transcripts: [], firstAgentAudioMs: null, stalled: false, agentTalkedDuring: false };
      r.utterances.push(utt);
      speaking = { pcm: s.clip, pos: 0, utt };
      lastSpoken = s;
      if (s.index !== null) lastSaid = s.index;
      agentText = "";
      heard = false;
      responded = false;
      log(`  caller> [${s.line}] ${mask(s.text)}`);
    };

    // ---------- controller: one tick every 50 ms ----------
    const tick = () => {
      if (stop) return;
      const t = now();
      if (t > TIMING.run) return finish("timeout", "run_timeout");
      if (closed) return finish(requiredLeft() ? "socket_closed" : "agent_ended_call", requiredLeft() ? "closed_before_script_end" : null);
      if (speaking) return;
      const utt = lastUtt();

      // A chosen line waits out the human reaction gap; if the agent starts talking again, re-decide later.
      if (reactAt !== null) {
        if (lastAudioAt > decidedAt) {
          reactAt = null;
          chosen = null;
        } else if (t >= reactAt) {
          const c = chosen!;
          reactAt = null;
          chosen = null;
          speak(c);
        }
        return;
      }

      if (!utt && lastAudioAt < 0 && t > TIMING.firstMessage) return finish("no_first_message", "no_first_message");

      if (utt && utt.endedMs !== null) {
        const since = t - utt.endedMs;
        const replied = lastActivityAt > utt.endedMs;
        if (!replied && since > TIMING.stall) utt.stalled = true;
        if (!requiredLeft()) {
          // Script done: give the agent time to say goodbye and end the call.
          if (t - Math.max(utt.endedMs, lastActivityAt) > TIMING.closeWait) return finish("script_complete");
        } else if (!replied && since > TIMING.silentRepeat && lastSpoken) {
          if (silentRepeats >= 1) return finish("agent_silent", `agent_silent_after:${utt.line}`);
          silentRepeats++;
          log(`  (agent silent ${Math.round(since / 1000)}s; caller repeats)`);
          speak({ ...lastSpoken, line: `${lastSpoken.line.split("#")[0]}#repeat` });
          return;
        } else if (replied && t - Math.max(lastActivityAt, playbackEnd) > TIMING.deadAir) {
          return finish("desync", `dead_air_after:${utt.line}`);
        }
      }

      // Has the agent finished its turn?
      const drained = t >= playbackEnd + TIMING.drainPad;
      if (!(heard && drained && (responded || t - lastAudioAt >= TIMING.doneSilence))) return;
      heard = false;
      responded = false;
      silentRepeats = 0;

      const d = decide(lines, pending, lastSaid, agentText);
      if (d.kind === "none") {
        unmatched++;
        log(`  (no line matches the agent's turn; ${unmatched}/${MAX_UNMATCHED})`);
        if (unmatched >= MAX_UNMATCHED) finish("desync", `no_match_after:${lastSaid === null ? "start" : lines[lastSaid]!.id}`);
        return;
      }
      unmatched = 0;
      if (d.kind === "checkin") {
        if (++checkins > MAX_CHECKINS) return finish("desync", "checkin_loop");
        chosen = { clip: input.checkinClip, line: "checkin", text: CHECKIN_REPLY, index: null };
      } else if (d.kind === "repeat") {
        const n = (repeats.get(d.index) ?? 0) + 1;
        repeats.set(d.index, n);
        if (n > MAX_REPEATS) return finish("desync", `reask_loop:${lines[d.index]!.id}`);
        chosen = { clip: input.clips[d.index]!, line: `${lines[d.index]!.id}#reask${n}`, text: lines[d.index]!.say, index: d.index };
      } else {
        checkins = 0;
        pending = pending.filter((i) => i !== d.index && !d.skipped.includes(i));
        chosen = { clip: input.clips[d.index]!, line: lines[d.index]!.id, text: lines[d.index]!.say, index: d.index };
      }
      decidedAt = t;
      reactAt = t + TIMING.reaction;
    };

    // ---------- server events ----------
    ws.onopen = () => {
      send({ type: "conversation_initiation_client_data", dynamic_variables: { canary: "true" } });
      timer = setInterval(tick, 50);
    };
    ws.onmessage = (e) => {
      const m = JSON.parse(String(e.data));
      const t = now();
      switch (m.type) {
        case "conversation_initiation_metadata": {
          const ev = m.conversation_initiation_metadata_event ?? {};
          r.conversationId = ev.conversation_id ?? null;
          r.userInputFormat = ev.user_input_audio_format ?? null;
          r.agentOutputFormat = ev.agent_output_audio_format ?? null;
          log(`  conversation ${r.conversationId} in=${r.userInputFormat} out=${r.agentOutputFormat}`);
          if (r.userInputFormat !== "pcm_16000" || r.agentOutputFormat !== "pcm_16000") {
            return finish("bad_audio_format", `audio_format in=${r.userInputFormat} out=${r.agentOutputFormat}`);
          }
          void mic();
          break;
        }
        case "audio": {
          const b64: string = m.audio_event?.audio_base_64 ?? "";
          const samples = fromBytes(new Uint8Array(Buffer.from(b64, "base64"))).length;
          playbackEnd = Math.max(playbackEnd, t) + (samples / RATE) * 1000;
          lastAudioAt = t;
          lastActivityAt = t;
          heard = true;
          const utt = lastUtt();
          if (utt) {
            if (utt.endedMs === null) utt.agentTalkedDuring = true;
            else if (utt.firstAgentAudioMs === null) utt.firstAgentAudioMs = Math.round(t - utt.endedMs);
          }
          break;
        }
        case "agent_response": {
          const text: string = m.agent_response_event?.agent_response ?? "";
          if (!text.trim()) break;
          agentText += (agentText ? " " : "") + text;
          responded = true;
          lastActivityAt = t;
          r.agentTurns.push({ ms: Math.round(t), text: mask(text) });
          log(`  agent > ${mask(text)}`);
          break;
        }
        case "user_transcript": {
          const text: string = m.user_transcription_event?.user_transcript ?? "";
          lastUtt()?.transcripts.push(mask(text));
          log(`  asr   > ${mask(text)}`);
          break;
        }
        case "interruption":
          r.interruptions++;
          break;
        case "ping":
          send({ type: "pong", event_id: m.ping_event?.event_id });
          break;
      }
    };
    ws.onerror = () => log("  websocket error");
    ws.onclose = (e) => {
      closed = true;
      r.closeCode = e.code;
      setTimeout(tick, 100); // finishes the run on the next tick
    };
  });
}
