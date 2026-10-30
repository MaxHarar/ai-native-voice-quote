import type { Repo } from "../db";
import type { SlidingWindowLimiter } from "../security/rateLimit";
import type { Alerter } from "./alerts";
import { createBackup, type BackupStore } from "./backup";
import { runRetention, type RetentionPolicy } from "./retention";

// In-process jobs for a single-instance service. Each job records its last run in the meta table,
// so restarts don't re-run work early and the ops console can show when each job last ran.

export interface SchedulerDeps {
  repo: Repo;
  alerter: Alerter;
  limiter: SlidingWindowLimiter;
  retention: RetentionPolicy;
  backupStore?: BackupStore;
  backupRetentionDays: number;
  canaryExpected: boolean;
  canaryMaxSilenceHours: number;
  now?: () => Date;
  log?: (l: Record<string, unknown>) => void;
}

const HOUR = 3600_000;

export class Scheduler {
  private timers: ReturnType<typeof setInterval>[] = [];
  private readonly bootedAt: number;

  constructor(private readonly d: SchedulerDeps) {
    this.bootedAt = this.now().getTime();
  }

  private now() {
    return this.d.now ? this.d.now() : new Date();
  }
  private log(l: Record<string, unknown>) {
    (this.d.log ?? ((x) => console.log(JSON.stringify(x))))(l);
  }

  start() {
    const every = (ms: number, fn: () => unknown, firstDelayMs = 60_000) => {
      const run = async () => {
        try {
          await fn();
        } catch (e) {
          this.log({ level: "error", message: "scheduled job failed", error: (e as Error).message });
        }
      };
      this.timers.push(setTimeout(run, firstDelayMs) as unknown as ReturnType<typeof setInterval>);
      this.timers.push(setInterval(run, ms));
    };
    every(6 * HOUR, () => this.retention());
    every(HOUR, () => this.backupIfDue(), 5 * 60_000);
    every(15 * 60_000, () => this.deadManCheck(), 20 * 60_000);
    every(5 * 60_000, () => this.toolErrorSpike(), 5 * 60_000);
    every(10 * 60_000, () => this.d.limiter.sweep(15 * 60_000));
  }

  stop() {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
  }

  retention() {
    const r = runRetention(this.d.repo.db, this.now(), this.d.retention);
    this.d.repo.setMeta("retention_last", JSON.stringify({ at: this.now().toISOString(), ...r }));
    this.log({ level: "info", message: "retention", ...r });
    return r;
  }

  async backupIfDue(): Promise<string | null> {
    if (!this.d.backupStore) return null;
    const last = this.d.repo.getMeta("backup_last");
    const lastAt = last ? new Date((JSON.parse(last) as { at: string }).at).getTime() : 0;
    if (this.now().getTime() - lastAt < 23 * HOUR) return null;
    try {
      const r = await createBackup(this.d.repo.db, this.d.backupStore, this.now(), this.d.backupRetentionDays);
      this.d.repo.setMeta("backup_last", JSON.stringify({ at: this.now().toISOString(), key: r.key, bytes: r.bytes, quotes: r.quotes }));
      this.log({ level: "info", message: "backup", key: r.key, bytes: r.bytes, pruned: r.pruned.length });
      return r.key;
    } catch (e) {
      await this.d.alerter.send({ key: "backup_failed", severity: "warning", title: "Nightly backup failed", detail: (e as Error).message });
      throw e;
    }
  }

  /** The external canary pings every hour; silence means monitoring itself is broken (e.g. GitHub disabled the cron). */
  async deadManCheck(): Promise<boolean> {
    if (!this.d.canaryExpected) return false;
    const last = this.d.repo.getMeta("canary_last_heartbeat");
    const since = last ? new Date(last).getTime() : this.bootedAt;
    const silentHours = (this.now().getTime() - since) / HOUR;
    if (silentHours < this.d.canaryMaxSilenceHours) return false;
    await this.d.alerter.send({
      key: "canary_silent",
      severity: "warning",
      title: `External canary silent for ${silentHours.toFixed(1)} hours`,
      detail: "The hourly GitHub Actions canary hasn't checked in. Check the workflow (GitHub disables scheduled workflows after 60 days without repo activity).",
    });
    return true;
  }

  /** Several internal tool failures in a short window means callers are hitting errors right now. */
  async toolErrorSpike(): Promise<number> {
    const since = new Date(this.now().getTime() - 15 * 60_000).toISOString();
    const n = this.d.repo.db
      .query<{ n: number }, [string]>("SELECT COUNT(*) n FROM call_events WHERE ok = 0 AND error IN ('INTERNAL','TIMEOUT','RATE_LIMITED') AND created_at >= ?")
      .get(since)!.n;
    if (n >= 5) await this.d.alerter.send({ key: "tool_errors", severity: "critical", title: `${n} tool failures in the last 15 minutes`, detail: "Callers are getting errors. Check the ops console and Railway logs." });
    return n;
  }
}
