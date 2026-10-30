import { describe, expect, test } from "bun:test";
import { PROMOTE_AFTER, recordWatched, type WatchHistory } from "../scripts/watchHistory";

// C11 (review 2026-10-16): watched eval tasks keep a pass history and earn a promotion hint.

describe("watched eval history", () => {
  test("appends one result per task per release and reports failures", () => {
    const r = recordWatched({}, { "price-objection": true, "license-callback": false }, "2026-10-16T00:00:00Z", "abc1234");
    expect(r.history["price-objection"]).toEqual([{ at: "2026-10-16T00:00:00Z", sha: "abc1234", pass: true }]);
    expect(r.failed).toEqual(["license-callback"]);
    expect(r.promote).toEqual([]);
  });

  test(`${PROMOTE_AFTER} consecutive passes print a promotion hint; a failure resets the streak`, () => {
    let h: WatchHistory = {};
    const run = (pass: boolean) => {
      const r = recordWatched(h, { t: pass }, "now", "sha");
      h = r.history;
      return r.promote;
    };
    expect(run(true)).toEqual([]);
    expect(run(true)).toEqual([]);
    expect(run(true)).toEqual(["t"]);
    expect(run(false)).toEqual([]);
    expect(run(true)).toEqual([]);
  });

  test("history is capped", () => {
    let h: WatchHistory = {};
    for (let k = 0; k < 50; k++) h = recordWatched(h, { t: true }, String(k), "sha").history;
    expect(h.t!.length).toBe(20);
    expect(h.t!.at(-1)!.at).toBe("49");
  });
});
