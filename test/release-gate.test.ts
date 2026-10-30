import { describe, expect, test } from "bun:test";
import { evalGate, failedTasks, previousAgentRef } from "../scripts/releaseGate";

// Release 936ef62 (2026-10-20) aborted on a blocking eval AFTER the server and agent were deployed and only PRINTED the
// rollback command, leaving the new build live and untagged. The failing trial's start_quote never reached the server
// and the task passed 2/2 on a manual rerun, so one LLM/platform flake must not roll back a good release either.
// evalGate is the whole decision: tag, retry the failing blocking tasks once, or roll back.

const BLOCKING = ["happy-path", "pa-happy-path", "human-request", "name-correction"];
const pass = (task: string) => ({ task, n: 1, c: 1 });
const fail = (task: string) => ({ task, n: 1, c: 0 });

describe("failedTasks", () => {
  test("a task fails when any trial failed or it is missing from the report", () => {
    expect(failedTasks([pass("a"), { task: "b", n: 2, c: 1 }], ["a", "b", "c"])).toEqual(["b", "c"]);
  });
});

describe("evalGate", () => {
  test("every blocking task passed: tag", () => {
    expect(evalGate(BLOCKING, BLOCKING.map(pass))).toEqual({ action: "tag", failing: [] });
  });

  test("a watched task failing never changes the decision", () => {
    expect(evalGate(BLOCKING, [...BLOCKING.map(pass), fail("price-objection")]).action).toBe("tag");
  });

  test("a blocking failure with no retry yet: retry ONLY the failing blocking tasks", () => {
    const first = [pass("happy-path"), fail("pa-happy-path"), pass("human-request"), fail("name-correction")];
    expect(evalGate(BLOCKING, first)).toEqual({ action: "retry", failing: ["pa-happy-path", "name-correction"] });
  });

  test("the retry passes every task that failed (the 936ef62 flake): tag", () => {
    const first = [pass("happy-path"), fail("pa-happy-path"), pass("human-request"), pass("name-correction")];
    expect(evalGate(BLOCKING, first, [pass("pa-happy-path")])).toEqual({ action: "tag", failing: [] });
  });

  test("a task still failing on retry: roll back, naming only the tasks that failed twice", () => {
    const first = [pass("happy-path"), fail("pa-happy-path"), pass("human-request"), fail("name-correction")];
    expect(evalGate(BLOCKING, first, [pass("pa-happy-path"), fail("name-correction")])).toEqual({ action: "rollback", failing: ["name-correction"] });
  });

  test("a retry report that is missing a retried task counts as a failure: roll back", () => {
    const first = [fail("happy-path"), pass("pa-happy-path"), pass("human-request"), pass("name-correction")];
    expect(evalGate(BLOCKING, first, [])).toEqual({ action: "rollback", failing: ["happy-path"] });
  });
});

describe("previousAgentRef: which commit's agent config to redeploy on rollback", () => {
  test("prefers the git sha the last agent deploy recorded in deployed.json", () => {
    expect(previousAgentRef({ git_sha: "936ef62aaaa" }, "release-202610200100-36b87a9")).toEqual({ ref: "936ef62aaaa", source: "deployed.json" });
  });

  test("falls back to the latest release tag when deployed.json predates the git_sha field", () => {
    expect(previousAgentRef({ agent_id: "x" }, "release-202610200100-36b87a9")).toEqual({ ref: "release-202610200100-36b87a9", source: "release-tag" });
  });

  test("nothing known: null, so the release alerts for a manual agent rollback instead of guessing", () => {
    expect(previousAgentRef(null, null)).toBeNull();
    expect(previousAgentRef({ git_sha: "" }, "")).toBeNull();
  });
});
