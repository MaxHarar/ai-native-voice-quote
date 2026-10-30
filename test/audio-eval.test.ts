// Unit tests for the pure parts of the audio-level eval runner (evals/audio/).
// No network, no ffmpeg: G.711 mu-law, SNR mixing math, script turn matching, and scoring
// against a fixture conversation (fake data, shaped like GET /v1/convai/conversations/{id}).

import { describe, expect, test } from "bun:test";
import { activeRms, biquad, chunkSamples, downsample2, gainForSnr, mixAtGain, mulawDecode, mulawEncode, pinkNoise, pstnChain, rms, snrDb, upsample2 } from "../evals/audio/audio";
import { decide, type Line } from "../evals/audio/match";
import { SCRIPTS, scriptById } from "../evals/audio/scripts";
import { countReasks, droppedCount, extractToolCalls, mask, normalizeSlot, percentile, REASK_RE, scoreSlots, type Utterance } from "../evals/audio/score";
import fixture from "../evals/audio/fixtures/conversation.json";

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));

describe("G.711 mu-law", () => {
  test("encode keeps length and yields one byte per sample", () => {
    const x = Int16Array.from([0, 1, -1, 1000, -1000, 32767, -32768]);
    const enc = mulawEncode(x);
    expect(enc).toBeInstanceOf(Uint8Array);
    expect(enc.length).toBe(x.length);
    expect(mulawDecode(enc)).toBeInstanceOf(Int16Array);
    expect(mulawDecode(enc).length).toBe(x.length);
  });

  test("standard code points", () => {
    expect(mulawEncode(Int16Array.from([0]))[0]).toBe(0xff);
    expect(mulawEncode(Int16Array.from([32767]))[0]).toBe(0x80);
    expect(mulawEncode(Int16Array.from([-32768]))[0]).toBe(0x00);
  });

  test("round trip error is bounded by the logarithmic step size", () => {
    for (let v = -32768; v <= 32767; v += 97) {
      const back = mulawDecode(mulawEncode(Int16Array.from([v])))[0]!;
      expect(Math.abs(back - v)).toBeLessThanOrEqual(Math.max(16, Math.abs(v) / 16));
    }
  });

  test("round trip is sign-symmetric and idempotent on decoded values", () => {
    for (let v = 1; v < 32000; v += 211) {
      const p = mulawDecode(mulawEncode(Int16Array.from([v])))[0]!;
      const n = mulawDecode(mulawEncode(Int16Array.from([-v])))[0]!;
      expect(n + p).toBe(0);
    }
    for (let code = 0; code < 256; code++) {
      if (code === 0x7f) continue; // negative zero; encodes back to 0xFF
      expect(mulawEncode(mulawDecode(Uint8Array.from([code])))[0]).toBe(code);
    }
  });
});

describe("telephone channel DSP", () => {
  const tone = (hz: number, n = 16000, amp = 8000) => Int16Array.from({ length: n }, (_, i) => Math.round(amp * Math.sin((2 * Math.PI * hz * i) / 16000)));
  // skip filter warm-up when measuring
  const body = (x: Int16Array) => x.subarray(2000, x.length - 2000);

  test("resampling halves and doubles the length", () => {
    const x = tone(1000);
    expect(downsample2(x).length).toBe(8000);
    expect(upsample2(downsample2(x)).length).toBe(16000);
  });

  test("downsample then upsample preserves an in-band tone", () => {
    const x = tone(1000);
    const y = upsample2(downsample2(x));
    expect(rms(body(y)) / rms(body(x))).toBeGreaterThan(0.9);
    expect(rms(body(y)) / rms(body(x))).toBeLessThan(1.1);
  });

  test("pstn chain passes speech band and removes out-of-band energy", () => {
    const pass = pstnChain(tone(1000));
    expect(pass.length).toBe(16000);
    expect(rms(body(pass)) / rms(body(tone(1000)))).toBeGreaterThan(0.85);
    expect(rms(body(pstnChain(tone(6000)))) / rms(body(tone(6000)))).toBeLessThan(0.05); // above 4 kHz Nyquist
    expect(rms(body(pstnChain(tone(100)))) / rms(body(tone(100)))).toBeLessThan(0.15); // below 300 Hz
    expect(rms(body(pstnChain(tone(3800)))) / rms(body(tone(3800)))).toBeLessThan(0.5); // above 3400 Hz
  });

  test("pink noise is deterministic and tilted toward low frequencies", () => {
    const a = pinkNoise(16000 * 2, 7);
    expect(Array.from(a.subarray(0, 50))).toEqual(Array.from(pinkNoise(16000 * 2, 7).subarray(0, 50)));
    expect(Array.from(a.subarray(0, 50))).not.toEqual(Array.from(pinkNoise(16000 * 2, 8).subarray(0, 50)));
    const low = rms(biquad(a, "lowpass", 500));
    const high = rms(biquad(biquad(a, "highpass", 4000), "lowpass", 4500));
    expect(low).toBeGreaterThan(high * 2);
    expect(rms(a)).toBeGreaterThan(1000);
  });
});

describe("SNR mixing", () => {
  const N = 16000;
  const sine = Int16Array.from({ length: N }, (_, i) => Math.round(8000 * Math.sin((2 * Math.PI * 1000 * i) / 16000)));
  let seed = 12345;
  const noise = Int16Array.from({ length: N }, () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return Math.round(((seed / 0x7fffffff) * 2 - 1) * 3000);
  });

  test("rms of a sine is amplitude / sqrt(2)", () => {
    expect(rms(sine)).toBeCloseTo(8000 / Math.SQRT2, -1);
  });

  test("activeRms ignores silent frames", () => {
    const half = new Int16Array(N * 2);
    half.set(sine, 0); // second half stays digital silence
    expect(rms(half)).toBeLessThan(rms(sine) * 0.75);
    expect(Math.abs(activeRms(half) - rms(sine)) / rms(sine)).toBeLessThan(0.02);
  });

  test("gainForSnr scales noise so the mix lands on the target SNR", () => {
    for (const target of [0, 10, 20]) {
      const g = gainForSnr(rms(sine), rms(noise), target);
      const mixed = mixAtGain(sine, noise, g);
      expect(mixed.length).toBe(sine.length);
      const residual = Int16Array.from(mixed, (m, i) => m - sine[i]!);
      expect(snrDb(rms(sine), rms(residual))).toBeCloseTo(target, 1);
    }
  });

  test("mix clips instead of wrapping", () => {
    const loud = Int16Array.from([30000, -30000]);
    const m = mixAtGain(loud, Int16Array.from([30000, -30000]), 1);
    expect(Array.from(m)).toEqual([32767, -32768]);
  });

  test("80 ms chunk at 16 kHz is 1280 samples", () => {
    expect(chunkSamples(80)).toBe(1280);
    expect(chunkSamples(50)).toBe(800);
  });
});

describe("script turn matching", () => {
  const lines: Line[] = [
    { id: "name", say: "Jordan Ellis.", when: /name/i },
    { id: "insured", say: "Yes.", when: /insurance/i, unless: /how (many|long)|months/i, optional: true },
    { id: "months", say: "Twelve.", when: /how (many|long)|months/i },
    { id: "dob", say: "March fourteenth.", when: /date of birth/i },
  ];

  test("answers the first pending line whose prompt matches", () => {
    expect(decide(lines, [0, 1, 2, 3], null, "Thanks for calling. What's your first and last name?")).toEqual({ kind: "say", index: 0, skipped: [] });
  });

  test("looks ahead past an optional line and drops it", () => {
    const d = decide(lines, [1, 2, 3], 0, "Do you have car insurance now, and how many months have you been insured?");
    expect(d).toEqual({ kind: "say", index: 2, skipped: [1] });
  });

  test("unless blocks a line even when when matches", () => {
    const d = decide(lines, [1, 2, 3], 0, "Do you have car insurance right now?");
    expect(d).toEqual({ kind: "say", index: 1, skipped: [] });
  });

  test("a re-ask of the line just said repeats it", () => {
    expect(decide(lines, [3], 2, "Sorry, I missed that. Roughly how many months?")).toEqual({ kind: "repeat", index: 2 });
  });

  test("a check-in with no question gets a check-in reply", () => {
    expect(decide(lines, [3], 2, "Did I lose you?")).toEqual({ kind: "checkin" });
  });

  test("unrelated speech matches nothing", () => {
    expect(decide(lines, [3], 2, "One moment while I pull your driving record.")).toEqual({ kind: "none" });
  });

  test("lookahead is limited to the window", () => {
    expect(decide(lines, [0, 1, 2, 3], null, "What's your date of birth?", 2)).toEqual({ kind: "none" });
  });

  test("every script is well formed", () => {
    expect(SCRIPTS.length).toBeGreaterThanOrEqual(3);
    for (const s of SCRIPTS) {
      const ids = s.lines.map((l) => l.id);
      expect(new Set(ids).size).toBe(ids.length);
      for (const l of s.lines) {
        expect(l.when).toBeInstanceOf(RegExp);
        expect(l.say).not.toMatch(/\d/); // spoken words only; TTS reads digits inconsistently
      }
      const zip = String(s.expected.start_quote?.zip);
      expect(zip).toMatch(/^(0[78]\d{3}|1[5-9]\d{3})$/); // NJ or PA only
      expect(s.expected.get_quote).toBeDefined();
    }
    expect(scriptById("happy-path-pa")).toBeDefined();
    expect(scriptById("short-answers")).toBeDefined();
    expect(scriptById("yes-after-readback")).toBeDefined();
  });
});

describe("scoring against a fixture conversation", () => {
  const script = scriptById("happy-path-pa")!;

  test("extracts tool calls from transcript params_as_json", () => {
    const calls = extractToolCalls(fixture);
    expect(calls.map((c) => c.tool)).toEqual(["start_quote", "save_driver", "save_driver", "save_vehicle", "set_coverage", "get_quote"]);
  });

  test("all expected slots match on the clean fixture (last save wins)", () => {
    const r = scoreSlots(script, extractToolCalls(fixture));
    expect(r.missingTools).toEqual([]);
    expect(r.forbiddenCalled).toEqual([]);
    expect(Object.values(r.slots).every(Boolean)).toBe(true);
    expect(r.slots["save_driver.license_number"]).toBe(true);
    expect(r.taskSuccess).toBe(true);
  });

  test("a wrong license number fails its slot and the task", () => {
    const bad = clone(fixture);
    const turn = bad.transcript.find((t: any) => t.tool_calls?.some((c: any) => c.tool_name === "save_driver" && c.params_as_json.includes("5678")))!;
    const call = turn.tool_calls[0]!;
    call.params_as_json = call.params_as_json.replace("5678", "5679");
    const r = scoreSlots(script, extractToolCalls(bad));
    expect(r.slots["save_driver.license_number"]).toBe(false);
    expect(r.slots["save_driver.date_of_birth"]).toBe(true);
    expect(r.taskSuccess).toBe(false);
  });

  test("a missing get_quote or a submitted application fails the task", () => {
    const noQuote = clone(fixture);
    noQuote.transcript = noQuote.transcript.filter((t: any) => !t.tool_calls?.some((c: any) => c.tool_name === "get_quote"));
    expect(scoreSlots(script, extractToolCalls(noQuote)).missingTools).toEqual(["get_quote"]);
    expect(scoreSlots(script, extractToolCalls(noQuote)).taskSuccess).toBe(false);

    const submitted = clone(fixture);
    submitted.transcript.push({ role: "agent", message: null, time_in_call_secs: 300, tool_calls: [{ tool_name: "submit_application", params_as_json: "{}" }] });
    const r = scoreSlots(script, extractToolCalls(submitted));
    expect(r.forbiddenCalled).toEqual(["submit_application"]);
    expect(r.taskSuccess).toBe(false);
  });

  test("slot normalization", () => {
    expect(normalizeSlot("license_number", "1234 5678")).toBe("12345678");
    expect(normalizeSlot("model", "535 i")).toBe("535i");
    expect(normalizeSlot("make", " bmw ")).toBe("bmw");
    expect(normalizeSlot("annual_miles", "15000")).toBe("15000");
    expect(normalizeSlot("dui_3y", "false")).toBe("false");
    expect(normalizeSlot("caller_name", "Jordan  ELLIS")).toBe("jordan ellis");
  });

  test("re-asks are counted from agent turns only", () => {
    expect(countReasks(fixture)).toBe(3);
    expect(REASK_RE.test("Could you say that again?")).toBe(true);
    expect(REASK_RE.test("Got it.")).toBe(false);
  });

  test("dropped utterances are those with no user transcript", () => {
    const u: Utterance[] = [
      { line: "name", text: "", startedMs: 0, endedMs: 1, transcripts: ["Jordan Ellis."], firstAgentAudioMs: 900, stalled: false, agentTalkedDuring: false },
      { line: "zip", text: "", startedMs: 2, endedMs: 3, transcripts: [], firstAgentAudioMs: null, stalled: true, agentTalkedDuring: false },
    ];
    expect(droppedCount(u)).toBe(1);
  });

  test("mask and percentile", () => {
    expect(mask("ZIP 18940, born 1991")).toBe("ZIP #####, born ####");
    expect(percentile([], 0.5)).toBeNull();
    expect(percentile([5, 1, 3], 0.5)).toBe(3);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.9)).toBe(9); // nearest rank
  });
});
