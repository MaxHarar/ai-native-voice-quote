// Pass history for the release script's WATCHED eval tasks (review 2026-10-16). A watched task never blocks a release,
// so its failures were easy to miss and nothing said when one had earned a place in the blocking set. Each release
// appends one pass/fail per watched task; three consecutive passes print a promotion hint.

export const PROMOTE_AFTER = 3;
const KEEP = 20;

export type WatchHistory = Record<string, { at: string; sha: string; pass: boolean }[]>;

export function recordWatched(
  history: WatchHistory,
  outcomes: Record<string, boolean>,
  at: string,
  sha: string,
): { history: WatchHistory; promote: string[]; failed: string[] } {
  const next: WatchHistory = { ...history };
  for (const [task, pass] of Object.entries(outcomes)) next[task] = [...(next[task] ?? []), { at, sha, pass }].slice(-KEEP);
  const promote = Object.keys(outcomes).filter((t) => {
    const runs = next[t]!.slice(-PROMOTE_AFTER);
    return runs.length === PROMOTE_AFTER && runs.every((r) => r.pass);
  });
  const failed = Object.entries(outcomes).filter(([, pass]) => !pass).map(([t]) => t);
  return { history: next, promote, failed };
}
