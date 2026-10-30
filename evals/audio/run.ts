#!/usr/bin/env bun
// Audio-level eval: streams SYNTHESIZED caller audio to the deployed ElevenLabs agent over the
// Agent WebSocket, under channel conditions (clean / pstn / noiseN), then scores each call from
// the post-call conversation record: tool-call slots, dropped utterances, re-asks, stalls, latency.
//
// Run from the repo directory, with the stale shell key removed so Bun loads the repo .env:
//   env -u ELEVENLABS_API_KEY bun evals/audio/run.ts --scripts happy-path-pa,short-answers --conditions clean,pstn,noise10 --repeats 1
//   env -u ELEVENLABS_API_KEY bun evals/audio/run.ts --dry-run --scripts short-answers --conditions noise10
// Every conversation sends dynamic_variables canary=true, so the server treats it as a test (no alerts).
// Digits are masked in everything printed or written, except slot comparison booleans.

import { mkdirSync } from "node:fs";
import { parseArgs } from "node:util";
import { activeRms, rms, wav } from "./audio";
import { parseCondition, prepare } from "./conditions";
import { CHECKIN_REPLY, SCRIPTS, type Script } from "./scripts";
import { runSession, type SessionResult } from "./session";
import { countReasks, droppedCount, extractToolCalls, mask, percentile, scoreSlots, type SlotScore } from "./score";
import { DEFAULT_TTS_MODEL, DEFAULT_VOICE, synth } from "./tts";

const { values: args } = parseArgs({
  options: {
    scripts: { type: "string" },
    conditions: { type: "string", default: "clean,pstn,noise10" },
    repeats: { type: "string", default: "1" },
    voice: { type: "string", default: DEFAULT_VOICE },
    "tts-model": { type: "string", default: DEFAULT_TTS_MODEL },
    "chunk-ms": { type: "string", default: "80" },
    "dry-run": { type: "boolean", default: false },
    quiet: { type: "boolean", default: false },
  },
});

const API = "https://api.elevenlabs.io";
const key = process.env.ELEVENLABS_API_KEY;
if (!key) throw new Error("ELEVENLABS_API_KEY not set (run from the repo dir with `env -u ELEVENLABS_API_KEY` so Bun loads .env)");
const deployed = await Bun.file(new URL("../../agent/deployed.json", import.meta.url)).json();
const agentId: string = process.env.ELEVENLABS_AGENT_ID ?? deployed.agent_id;

const scripts: Script[] = args.scripts ? args.scripts.split(",").map((id) => SCRIPTS.find((s) => s.id === id) ?? fail(`unknown script "${id}" (have: ${SCRIPTS.map((s) => s.id).join(", ")})`)) : SCRIPTS;
const conditions = args.conditions!.split(",").map((c) => c.trim()).filter(Boolean);
conditions.forEach(parseCondition); // validate early
const repeats = Math.max(1, Number(args.repeats));
const chunkMs = Number(args["chunk-ms"]);
if (!(chunkMs >= 50 && chunkMs <= 100)) fail("--chunk-ms must be between 50 and 100");
const runId = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15);
const RESULTS = new URL("./results/", import.meta.url).pathname;
mkdirSync(RESULTS, { recursive: true });
const log = (s: string) => args.quiet || console.log(s);

function fail(msg: string): never {
  console.error(msg);
  process.exit(2);
}

// ---------- caller audio (cached TTS) ----------
async function rawClips(script: Script) {
  const tts = { key: key!, voice: args.voice!, model: args["tts-model"]! };
  let fresh = 0;
  const clips: Int16Array[] = [];
  for (const line of script.lines) {
    const { pcm, cached } = await synth(line.say, tts);
    if (!cached) fresh++;
    clips.push(pcm);
  }
  const checkin = await synth(CHECKIN_REPLY, tts);
  if (!checkin.cached) fresh++;
  log(`tts ${script.id}: ${script.lines.length + 1} clips (${fresh} synthesized, ${script.lines.length + 1 - fresh} cached)`);
  return { clips, checkin: checkin.pcm };
}

// ---------- dry run: build and write processed audio, no WebSocket ----------
if (args["dry-run"]) {
  const out = `${RESULTS}dry-run-${runId}/`;
  for (const script of scripts) {
    const raw = await rawClips(script);
    for (const cond of conditions) {
      const dir = `${out}${script.id}/${cond}/`;
      mkdirSync(dir, { recursive: true });
      const p = prepare(cond, [...raw.clips, raw.checkin]);
      const rows = p.clips.map((c, i) => {
        const id = i < script.lines.length ? script.lines[i]!.id : "checkin";
        const name = `${String(i).padStart(2, "0")}-${id}.wav`;
        return { name, line: id, seconds: Number((c.length / 16000).toFixed(2)), active_rms: Math.round(activeRms(c)), bytes: c.byteLength, file: name };
      });
      await Promise.all(p.clips.map((c, i) => Bun.write(`${dir}${rows[i]!.file}`, wav(c))));
      if (p.bed) await Bun.write(`${dir}gap-bed.wav`, wav(p.bed.subarray(0, 16000 * 10)));
      await Bun.write(`${dir}manifest.json`, JSON.stringify({ script: script.id, condition: cond, ...p.info, bed_rms: p.bed ? Math.round(rms(p.bed)) : 0, clips: rows }, null, 2));
      log(`dry-run ${script.id} × ${cond}: ${rows.length} clips -> ${dir}${p.info.snr_measured_db !== undefined ? ` (SNR ${p.info.snr_measured_db} dB)` : ""}`);
    }
  }
  process.exit(0);
}

// ---------- live runs ----------
async function signedUrl(): Promise<string> {
  const res = await fetch(`${API}/v1/convai/conversation/get-signed-url?agent_id=${agentId}`, { headers: { "xi-api-key": key! }, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`get-signed-url HTTP ${res.status}`);
  const j = (await res.json()) as { signed_url?: string };
  if (!j.signed_url) throw new Error("get-signed-url returned no signed_url");
  return j.signed_url;
}

async function fetchConversation(id: string): Promise<any> {
  const deadline = Date.now() + 120_000;
  let last: any = null;
  while (Date.now() < deadline) {
    const res = await fetch(`${API}/v1/convai/conversations/${id}`, { headers: { "xi-api-key": key! }, signal: AbortSignal.timeout(20_000) }).catch(() => null);
    if (res?.ok) {
      last = await res.json();
      if (last.status === "done" || last.status === "failed") return last;
    }
    await Bun.sleep(5000);
  }
  return last;
}

interface RunRecord {
  script: string;
  condition: string;
  repeat: number;
  conversation_id: string | null;
  status: string | null;
  end_reason: string;
  desync: string | null;
  unsaid_required: string[];
  task_success: boolean;
  slots: Record<string, boolean>;
  slot_match: number;
  slot_mismatches_masked: Record<string, string>;
  missing_tools: string[];
  forbidden_called: string[];
  utterances: number;
  dropped: number;
  dropped_lines: string[];
  reasks: number;
  stalls: number;
  stalled_lines: string[];
  interruptions: number;
  agent_talked_during: number;
  latency_ms: number[];
  latency_p50: number | null;
  latency_p90: number | null;
  duration_s: number;
  user_turns_post_call: number;
  agent_turns_post_call: number;
  info: Record<string, unknown>;
  transcript_masked: { role: string; t: number; text: string; tools?: string[] }[];
  utterance_log: SessionResult["utterances"];
}

const records: RunRecord[] = [];
const outFile = `${RESULTS}${runId}.json`;
const save = () =>
  Bun.write(outFile, JSON.stringify({ run_id: runId, agent_id: agentId, voice: args.voice, tts_model: args["tts-model"], chunk_ms: chunkMs, conditions, repeats, runs: records }, null, 2));

for (const script of scripts) {
  const raw = await rawClips(script);
  for (const cond of conditions) {
    const p = prepare(cond, [...raw.clips, raw.checkin]);
    const clips = p.clips.slice(0, script.lines.length);
    const checkinClip = p.clips.at(-1)!;
    for (let rep = 1; rep <= repeats; rep++) {
      log(`\n=== ${script.id} × ${cond} #${rep} ===`);
      const s = await runSession({ signedUrl: await signedUrl(), lines: script.lines, clips, checkinClip, bed: p.bed, chunkMs, log: args.quiet ? undefined : log });
      log(`  end: ${s.endReason}${s.desync ? ` (desync: ${s.desync})` : ""}; fetching conversation record...`);
      const conv = s.conversationId ? await fetchConversation(s.conversationId) : null;
      const calls = conv ? extractToolCalls(conv) : [];
      const score: SlotScore = scoreSlots(script, calls);
      const lat = s.utterances.map((u) => u.firstAgentAudioMs).filter((x): x is number => x !== null);
      const slotVals = Object.values(score.slots);
      const transcript = (conv?.transcript ?? []) as any[];
      const rec: RunRecord = {
        script: script.id,
        condition: cond,
        repeat: rep,
        conversation_id: s.conversationId,
        status: conv?.status ?? null,
        end_reason: s.endReason,
        desync: s.desync,
        unsaid_required: s.unsaidRequired,
        task_success: score.taskSuccess && !s.desync,
        slots: score.slots,
        slot_match: slotVals.length ? slotVals.filter(Boolean).length / slotVals.length : 0,
        slot_mismatches_masked: score.mismatches,
        missing_tools: score.missingTools,
        forbidden_called: score.forbiddenCalled,
        utterances: s.utterances.length,
        dropped: droppedCount(s.utterances),
        dropped_lines: s.utterances.filter((u) => !u.transcripts.length).map((u) => u.line),
        reasks: conv ? countReasks(conv) : 0,
        stalls: s.utterances.filter((u) => u.stalled).length,
        stalled_lines: s.utterances.filter((u) => u.stalled).map((u) => u.line),
        interruptions: s.interruptions,
        agent_talked_during: s.utterances.filter((u) => u.agentTalkedDuring).length,
        latency_ms: lat,
        latency_p50: percentile(lat, 0.5),
        latency_p90: percentile(lat, 0.9),
        duration_s: Math.round(s.durationMs / 1000),
        user_turns_post_call: transcript.filter((t) => t.role === "user").length,
        agent_turns_post_call: transcript.filter((t) => t.role === "agent" && t.message).length,
        info: p.info,
        transcript_masked: transcript.map((t) => ({
          role: t.role,
          t: t.time_in_call_secs,
          text: mask(String(t.message ?? "")),
          ...(t.tool_calls?.length ? { tools: t.tool_calls.map((c: any) => `${c.tool_name} ${mask(c.params_as_json ?? "")}`) } : {}),
        })),
        utterance_log: s.utterances,
      };
      records.push(rec);
      await save();
      log(`  task=${rec.task_success ? "PASS" : "FAIL"} slots=${(rec.slot_match * 100).toFixed(0)}% dropped=${rec.dropped} reasks=${rec.reasks} stalls=${rec.stalls} p50=${rec.latency_p50}ms p90=${rec.latency_p90}ms`);
      if (Object.keys(rec.slot_mismatches_masked).length) log(`  slot mismatches: ${Object.keys(rec.slot_mismatches_masked).join(", ")}`);
    }
  }
}

// ---------- table ----------
const rows: string[][] = [["script", "condition", "runs", "task", "slots", "dropped", "re-asks", "stalls", "lat p50", "lat p90", "desync"]];
for (const script of scripts) {
  for (const cond of conditions) {
    const rs = records.filter((r) => r.script === script.id && r.condition === cond);
    if (!rs.length) continue;
    const lat = rs.flatMap((r) => r.latency_ms);
    const sum = (f: (r: RunRecord) => number) => rs.reduce((a, r) => a + f(r), 0);
    rows.push([
      script.id,
      cond,
      String(rs.length),
      `${rs.filter((r) => r.task_success).length}/${rs.length}`,
      `${((sum((r) => r.slot_match) / rs.length) * 100).toFixed(0)}%`,
      `${sum((r) => r.dropped)}/${sum((r) => r.utterances)}`,
      String(sum((r) => r.reasks)),
      String(sum((r) => r.stalls)),
      percentile(lat, 0.5) === null ? "-" : `${percentile(lat, 0.5)}ms`,
      percentile(lat, 0.9) === null ? "-" : `${percentile(lat, 0.9)}ms`,
      rs.map((r) => r.desync ?? "-").join(","),
    ]);
  }
}
const widths = rows[0]!.map((_, i) => Math.max(...rows.map((r) => r[i]!.length)));
console.log(`\n${rows.map((r) => r.map((c, i) => c.padEnd(widths[i]!)).join("  ")).join("\n")}`);
console.log(`\nresults: ${outFile}`);
