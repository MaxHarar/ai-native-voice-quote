import { loadConfig } from "./config";
import { openDb, Repo } from "./db";
import { Alerter, alertSettingsFrom } from "./ops/alerts";
import type { BackupStore } from "./ops/backup";
import { s3Store } from "./ops/s3";
import { Scheduler } from "./ops/scheduler";
import { createFieldCipher, DEV_ENCRYPTION_KEY } from "./security/crypto";
import { SlidingWindowLimiter } from "./security/rateLimit";
import { createApp, VERSION } from "./server/app";
import { QuoteService } from "./service";
import { modelsForMakeYear } from "./verify/vpic";

const log = (l: Record<string, unknown>) => console.log(JSON.stringify(l));

let cfg;
try {
  cfg = loadConfig();
} catch (e) {
  console.error(JSON.stringify({ level: "fatal", message: (e as Error).message }));
  process.exit(1);
}
if (!cfg.production) log({ level: "warn", message: "non-production mode: development fallbacks for keys may be active" });

const cipher = createFieldCipher(cfg.DATA_ENCRYPTION_KEY ?? DEV_ENCRYPTION_KEY, cfg.DATA_ENCRYPTION_KEY_PREVIOUS);
const repo = new Repo(openDb(cfg.DATABASE_PATH), cipher);

// Plaintext PII written before field encryption shipped is encrypted in place, once, when enabled
// (the release script takes a backup first). Dual-read handles mixed rows until then.
if (process.env.PII_ENCRYPTION_BACKFILL === "1") log({ level: "info", message: "pii backfill", ...repo.encryptLegacyRows() });

const service = new QuoteService({ repo, now: () => new Date(), licenseKey: cfg.LICENSE_HMAC_KEY, models: (make, year) => modelsForMakeYear(make, year) });
// Quotes saved before returning-caller support get their lookup hash so those callers are recognized.
const hashed = repo.backfillCallerHashes((phone) => service.callerHash(phone));
if (hashed) log({ level: "info", message: "caller hash backfill", quotes: hashed });

const alerter = new Alerter(repo, alertSettingsFrom(cfg));
const backupStore: BackupStore | undefined =
  cfg.BACKUP_BUCKET && cfg.BACKUP_ENDPOINT && cfg.BACKUP_ACCESS_KEY_ID && cfg.BACKUP_SECRET_ACCESS_KEY
    ? s3Store({ bucket: cfg.BACKUP_BUCKET, endpoint: cfg.BACKUP_ENDPOINT, region: cfg.BACKUP_REGION, accessKeyId: cfg.BACKUP_ACCESS_KEY_ID, secretAccessKey: cfg.BACKUP_SECRET_ACCESS_KEY, virtualHostedStyle: cfg.BACKUP_VIRTUAL_HOSTED === "true" })
    : undefined;
const retention = { mode: cfg.RETENTION_MODE, liveDays: cfg.RETENTION_DAYS_LIVE, evalDays: cfg.RETENTION_DAYS_EVAL };
const limiter = new SlidingWindowLimiter();
let shuttingDown = false;

const app = createApp({
  repo,
  service,
  toolSecret: cfg.TOOL_SECRET,
  toolSecretPrevious: cfg.TOOL_SECRET_PREVIOUS,
  adminSecret: cfg.ADMIN_SECRET,
  opsUser: cfg.OPS_USER,
  opsPassword: cfg.OPS_PASSWORD,
  elevenAgentId: cfg.ELEVENLABS_AGENT_ID,
  elevenApiKey: cfg.ELEVENLABS_API_KEY,
  webhookSecrets: [cfg.ELEVENLABS_WEBHOOK_SECRET, cfg.ELEVENLABS_WEBHOOK_SECRET_PREVIOUS].filter((s): s is string => !!s),
  canarySecret: cfg.CANARY_SECRET,
  initiationSecret: cfg.INITIATION_SECRET,
  alerter,
  backupStore,
  backupRetentionDays: cfg.BACKUP_RETENTION_DAYS,
  retention,
  publicBaseUrl: cfg.PUBLIC_BASE_URL,
  toolTimeoutMs: cfg.TOOL_TIMEOUT_MS,
  isShuttingDown: () => shuttingDown,
  limiter,
});

const server = Bun.serve({ port: cfg.PORT, fetch: app.fetch });
const scheduler = new Scheduler({
  repo,
  alerter,
  limiter,
  retention,
  backupStore,
  backupRetentionDays: cfg.BACKUP_RETENTION_DAYS,
  canaryExpected: !!cfg.CANARY_SECRET,
  canaryMaxSilenceHours: cfg.CANARY_MAX_SILENCE_HOURS,
});
scheduler.start();
log({
  level: "info",
  message: "listening",
  port: server.port,
  version: VERSION,
  production: cfg.production,
  backups: !!backupStore,
  alerts: { telegram: !!cfg.TELEGRAM_BOT_TOKEN, voice: !!cfg.ALERT_VOICE_TO },
  webhook: !!cfg.ELEVENLABS_WEBHOOK_SECRET,
  retention: retention.mode,
});

// Graceful shutdown: stop taking new requests (readiness flips to 503), let in-flight tool calls
// finish, checkpoint the WAL into the main database file, and close it cleanly.
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  log({ level: "info", message: "shutdown start", signal });
  scheduler.stop();
  await server.stop(false);
  try {
    repo.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    repo.db.close();
  } catch (e) {
    log({ level: "error", message: "shutdown db close failed", error: (e as Error).message });
  }
  log({ level: "info", message: "shutdown complete" });
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
