// Pure decisions for scripts/release.ts, kept out of the script so they are unit-tested (test/release-gate.test.ts).
//
// Incident: release 936ef62 (2026-10-20) failed a blocking eval AFTER the server and agent were deployed, then only
// PRINTED `bun scripts/release.ts --rollback <id>` and exited, leaving the new build live and untagged. The failing
// trial's start_quote never reached the server and the task passed 2/2 on a manual rerun: an LLM/platform flake. So a
// blocking failure first earns ONE retry of just the failing blocking tasks; only a task that fails twice rolls back.

export type TaskResult = { task: string; n: number; c: number };
export type EvalGate = { action: "tag" | "retry" | "rollback"; failing: string[] };

/** Tasks among `ids` that failed any trial or are missing from the report (a missing task never counts as a pass). */
export function failedTasks(results: TaskResult[], ids: string[]): string[] {
  return ids.filter((id) => {
    const t = results.find((r) => r.task === id);
    return !t || t.c < t.n;
  });
}

/**
 * first: results of the release's eval pass. retry: results of re-running only the failing blocking tasks, once.
 * Watched tasks are not in `blocking`, so they never affect the decision.
 */
export function evalGate(blocking: string[], first: TaskResult[], retry?: TaskResult[]): EvalGate {
  const failing = failedTasks(first, blocking);
  if (!failing.length) return { action: "tag", failing: [] };
  if (!retry) return { action: "retry", failing };
  const still = failedTasks(retry, failing);
  return still.length ? { action: "rollback", failing: still } : { action: "tag", failing: [] };
}

/**
 * The commit whose agent/config.ts + policy/ the live agent was deployed from, i.e. what an agent rollback redeploys.
 * agent/deploy.ts records git_sha in deployed.json; deployed.json files written before that field existed fall back to
 * the latest release tag. That fallback is wrong after an untagged deploy (936ef62's agent went live untagged), which
 * is why git_sha is recorded at all. Nothing known → null: the release alerts for a manual rollback rather than guess.
 */
export function previousAgentRef(
  deployed: { git_sha?: string; [field: string]: unknown } | null,
  lastReleaseTag: string | null,
): { ref: string; source: "deployed.json" | "release-tag" } | null {
  if (deployed?.git_sha) return { ref: deployed.git_sha, source: "deployed.json" };
  if (lastReleaseTag) return { ref: lastReleaseTag, source: "release-tag" };
  return null;
}
