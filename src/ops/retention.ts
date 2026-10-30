import type { Database } from "bun:sqlite";

// PII retention: quotes (with their drivers, vehicles, reports and applications via ON DELETE
// CASCADE), call records, call metrics, caller-number bindings, tool events, alerts and the access log are purged after a fixed window.
// Eval/canary/load rows go sooner. Ships in dry-run mode: it logs what it WOULD delete until
// RETENTION_MODE=enforce, so the first production run can be inspected before anything is removed.
//
// Note for the record: nightly backups keep snapshots for BACKUP_RETENTION_DAYS, so a purged row can
// survive in a backup for up to that many extra days (documented in docs/SECURITY.md).

export interface RetentionPolicy {
  mode: "dry-run" | "enforce";
  liveDays: number;
  evalDays: number;
}

export interface RetentionResult {
  mode: RetentionPolicy["mode"];
  quotesLive: number;
  quotesTest: number;
  calls: number;
  callEvents: number;
  alerts: number;
  accessLog: number;
  callMetrics: number;
  callBindings: number;
  vinCache: number;
}

const iso = (d: Date) => d.toISOString();

export function runRetention(db: Database, now: Date, p: RetentionPolicy): RetentionResult {
  const liveCut = iso(new Date(now.getTime() - p.liveDays * 86400_000));
  const evalCut = iso(new Date(now.getTime() - p.evalDays * 86400_000));
  const statements: [keyof Omit<RetentionResult, "mode">, string, string[]][] = [
    ["quotesLive", "FROM quotes WHERE eval_tag = 'live' AND created_at < ?", [liveCut]],
    ["quotesTest", "FROM quotes WHERE eval_tag <> 'live' AND created_at < ?", [evalCut]],
    ["calls", "FROM calls WHERE (is_test = 0 AND received_at < ?) OR (is_test = 1 AND received_at < ?)", [liveCut, evalCut]],
    ["callEvents", "FROM call_events WHERE created_at < ?", [liveCut]],
    ["alerts", "FROM alerts WHERE created_at < ?", [liveCut]],
    ["accessLog", "FROM access_log WHERE created_at < ?", [liveCut]],
    ["callMetrics", "FROM call_metrics WHERE (is_test = 0 AND created_at < ?) OR (is_test = 1 AND created_at < ?)", [liveCut, evalCut]],
    // The caller's number (encrypted) and its lookup hash, one row per call; these used to outlive everything else.
    // No is_test column here: eval simulations are the sim_ conversations, the same split the webhooks use.
    ["callBindings", "FROM call_bindings WHERE (substr(conversation_id, 1, 4) <> 'sim_' AND created_at < ?) OR (substr(conversation_id, 1, 4) = 'sim_' AND created_at < ?)", [liveCut, evalCut]],
    // VIN -> decoded vehicle. No caller linkage, but a VIN identifies one car, and every VIN ever spoken on the line used
    // to stay forever. A re-decode costs one vPIC call, so nothing outlives the live window (review 2026-10-16).
    ["vinCache", "FROM vin_cache WHERE fetched_at < ?", [liveCut]],
  ];
  const result: RetentionResult = { mode: p.mode, quotesLive: 0, quotesTest: 0, calls: 0, callEvents: 0, alerts: 0, accessLog: 0, callMetrics: 0, callBindings: 0, vinCache: 0 };
  const tx = db.transaction(() => {
    for (const [field, clause, args] of statements) {
      result[field] = db.query<{ n: number }, string[]>(`SELECT COUNT(*) n ${clause}`).get(...args)!.n;
      if (p.mode === "enforce" && result[field] > 0) db.query(`DELETE ${clause}`).run(...args);
    }
  });
  tx();
  return result;
}
