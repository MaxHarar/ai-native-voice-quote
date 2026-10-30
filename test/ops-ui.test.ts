import { describe, expect, test } from "bun:test";
import { openDb, Repo } from "../src/db";
import { SlidingWindowLimiter } from "../src/security/rateLimit";
import { byteRange, createApp, createAudioCache } from "../src/server/app";
import { fetchConversation, maskDigits } from "../src/server/transcript";
import { QuoteService } from "../src/service";

// Defects from the 2026-10-15 UI reproduction pass (scratchpad/ui-bugs.md): the recording player showed
// 0:00 / 0:00 and couldn't seek, failed tool calls showed a green "ok", /ops was audited twice, and a license
// read back in words appeared unmasked in the transcript.

const AUTH = { authorization: "Basic " + Buffer.from("ops:ops-password-123").toString("base64") };
const AUDIO = new Uint8Array(Array.from({ length: 1000 }, (_, i) => i % 256));

function build(fetchAudioImpl?: (id: string) => Promise<Response | null>) {
  const repo = new Repo(openDb(":memory:"));
  const service = new QuoteService({ repo, now: () => new Date("2026-10-15T15:00:00Z"), licenseKey: "k" });
  let audioCalls = 0;
  const app = createApp({
    repo, service, toolSecret: "test-secret-test-secret-123456", limiter: new SlidingWindowLimiter(), log: () => {},
    opsUser: "ops", opsPassword: "ops-password-123", fetchMeta: async () => null, fetchTranscript: async () => null,
    fetchAudio: fetchAudioImpl ?? (async () => { audioCalls++; return new Response(AUDIO, { headers: { "content-type": "audio/mpeg" } }); }),
  });
  return { repo, app, audioCalls: () => audioCalls };
}

describe("call recording endpoint", () => {
  test("serves the whole file with a length, byte ranges, and the security headers", async () => {
    const { app } = build();
    const res = await app.request("/ops/quote/conv_abc/audio", { headers: AUTH });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-length")).toBe("1000");
    expect(res.headers.get("accept-ranges")).toBe("bytes");
    expect(res.headers.get("content-type")).toBe("audio/mpeg");
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-security-policy")).toBeTruthy();
    expect((await res.arrayBuffer()).byteLength).toBe(1000);
  });

  test("answers a range request with 206 and the exact bytes", async () => {
    const { app } = build();
    const res = await app.request("/ops/quote/conv_abc/audio", { headers: { ...AUTH, range: "bytes=10-19" } });
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe("bytes 10-19/1000");
    expect(res.headers.get("content-length")).toBe("10");
    expect([...new Uint8Array(await res.arrayBuffer())]).toEqual([...AUDIO.slice(10, 20)]);
  });

  test("an out-of-range request is 416 with the total size", async () => {
    const { app } = build();
    const res = await app.request("/ops/quote/conv_abc/audio", { headers: { ...AUTH, range: "bytes=5000-" } });
    expect(res.status).toBe(416);
    expect(res.headers.get("content-range")).toBe("bytes */1000");
  });

  test("seeking reuses the cached file instead of refetching", async () => {
    const b = build();
    await b.app.request("/ops/quote/conv_abc/audio", { headers: AUTH });
    await b.app.request("/ops/quote/conv_abc/audio", { headers: { ...AUTH, range: "bytes=500-" } });
    expect(b.audioCalls()).toBe(1);
  });

  test("missing audio is a 404, and the route stays behind the login", async () => {
    const { app } = build(async () => null);
    expect((await app.request("/ops/quote/conv_x/audio", { headers: AUTH })).status).toBe(404);
    expect((await app.request("/ops/quote/conv_x/audio")).status).toBe(401);
  });
});

describe("byteRange", () => {
  test("parses open, closed and suffix ranges and rejects bad ones", () => {
    expect(byteRange(undefined, 100)).toBeNull();
    expect(byteRange("items=0-1", 100)).toBeNull();
    expect(byteRange("bytes=-", 100)).toBeNull();
    expect(byteRange("bytes=0-", 100)).toEqual({ start: 0, end: 99 });
    expect(byteRange("bytes=90-200", 100)).toEqual({ start: 90, end: 99 });
    expect(byteRange("bytes=-10", 100)).toEqual({ start: 90, end: 99 });
    expect(byteRange("bytes=-0", 100)).toBe("unsatisfiable");
    expect(byteRange("bytes=100-", 100)).toBe("unsatisfiable");
    expect(byteRange("bytes=50-40", 100)).toBe("unsatisfiable");
  });
});

describe("createAudioCache", () => {
  test("expires entries and evicts the least recently used", () => {
    let t = 0;
    const cache = createAudioCache(2, 1000, () => t);
    cache.put("a", new ArrayBuffer(1));
    cache.put("b", new ArrayBuffer(1));
    expect(cache.get("a")).toBeDefined();
    cache.put("c", new ArrayBuffer(1));
    expect(cache.get("b")).toBeUndefined();
    t = 5000;
    expect(cache.get("a")).toBeUndefined();
  });
});

describe("ops console", () => {
  test("each /ops request is audited once", async () => {
    const { app, repo } = build();
    await app.request("/ops", { headers: AUTH });
    expect(repo.recentAccess(10).filter((a) => a.path === "/ops").length).toBe(1);
  });

  test("the favicon request doesn't 404", async () => {
    const { app } = build();
    expect((await app.request("/favicon.ico")).status).toBe(204);
  });
});

describe("transcript parsing", () => {
  const convo = (results: { is_error?: boolean; result_value?: string }[]) =>
    (async () =>
      new Response(
        JSON.stringify({ status: "done", has_audio: true, metadata: { call_duration_secs: 60 }, transcript: [{ role: "agent", message: "Checking.", time_in_call_secs: 3, tool_results: results.map((r) => ({ tool_name: "save_driver", ...r })) }] }),
        { headers: { "content-type": "application/json" } },
      )) as unknown as typeof fetch;

  test("a tool answer of ok:false is shown as an error even when the platform call succeeded", async () => {
    const c = await fetchConversation("conv_1", "key", convo([{ is_error: false, result_value: JSON.stringify({ ok: false, error: "DOB_MISMATCH", hint: "x" }) }, { result_value: JSON.stringify({ ok: true }) }, { is_error: true, result_value: "boom" }]));
    expect(c!.turns[0]!.results.map((r) => r.ok)).toEqual([false, true, false]);
  });

  test("404 means gone; timeouts and server errors mean try again", async () => {
    const status = (code: number) => (async () => new Response("x", { status: code })) as unknown as typeof fetch;
    expect(await fetchConversation("conv_1", "key", status(404))).toBeNull();
    expect((await fetchConversation("conv_1", "key", status(503)))?.unavailable).toBe(true);
    const timeout = (async () => { throw new DOMException("timed out", "TimeoutError"); }) as unknown as typeof fetch;
    expect((await fetchConversation("conv_1", "key", timeout))?.unavailable).toBe(true);
    expect(await fetchConversation("conv_1", undefined, status(200))).toBeNull();
  });

  test("license numbers are masked whether read as numerals or as words", () => {
    expect(maskDigits("S 10000000000001")).toBe("S ••••••••••0001");
    expect(maskDigits("S, one zero zero zero, zero zero zero zero, zero zero zero one")).toBe("S, ••••••••0001");
    expect(maskDigits("Is it eight two five, five five five, one two three four?")).toBe("Is it ••••••1234?");
    expect(maskDigits("One sixty-one eighty-three a month, and one, two, three cars")).toBe("One sixty-one eighty-three a month, and one, two, three cars");
  });
});

describe("maskDigits read-back groups", () => {
  test("comma-separated numeral groups are masked; a ZIP next to a small number is not", () => {
    expect(maskDigits("S, 1000, 0000, 0000, 0001")).toBe("S, ••••••••••••0001");
    expect(maskDigits("That's 215, 620, 4887?")).toBe("That's ••••••4887?");
    expect(maskDigits("ZIP 08540, 24 months")).toBe("ZIP 08540, 24 months");
    expect(maskDigits("someone with a phone, none of it")).toBe("someone with a phone, none of it");
  });
});

describe("ops page rendering fixes", () => {
  test("labels, eligibility text and the quote page's empty states, player and dark mode", async () => {
    const { statusLabel, eligibilityText, renderOpsQuote } = await import("../src/server/ops");
    const now = new Date("2026-10-15T15:00:00Z").getTime();
    expect(statusLabel("open", "2026-10-15T14:55:00Z", false, now)).toBe("open");
    expect(statusLabel("open", "2026-10-15T14:55:00Z", true, now)).toBe("incomplete");
    expect(statusLabel("open", "2026-10-15T14:00:00Z", false, now)).toBe("incomplete");
    expect(statusLabel("applied", "2026-10-15T10:00:00Z", true, now)).toBe("applied");
    expect(eligibilityText('{"status":"OK"}')).toBe("OK");
    expect(eligibilityText('{"status":"REFER","reasons":["DUI_WITHIN_3Y","LICENSE_NOT_VALID"]}')).toBe("Refer: dui within 3 years, license not valid");
    expect(eligibilityText("not json")).toBe("not json");

    const { repo } = build();
    repo.upsertQuoteStart({ id: "conv_page", evalTag: "live", callerName: "Pat Lee", callerPhone: null, zip: "08540", state: "NJ", territory: 3, priorInsuranceMonths: 12 });
    const unavailable = renderOpsQuote(repo, "conv_page", { conversation: { status: null, durationSecs: null, turns: [], hasAudio: false, unavailable: true } })!;
    expect(unavailable).toContain("temporarily unavailable from ElevenLabs");
    expect(unavailable).toContain("None yet.");
    expect(unavailable).toContain("color-scheme:light dark");
    const withAudio = renderOpsQuote(repo, "conv_page", { conversation: { status: "done", durationSecs: 60, turns: [], hasAudio: true } })!;
    expect(withAudio).toContain('preload="metadata"');
  });
});
