import { z } from "zod";

// All runtime configuration, parsed and validated once at boot. In production a missing or weak
// secret stops the process before it accepts a single call, instead of failing mid-conversation.

const base64Key32 = z
  .string()
  .refine((v) => Buffer.from(v, "base64").length === 32, "must be 32 bytes, base64-encoded (openssl rand -base64 32)");

const schema = z.object({
  NODE_ENV: z.string().default("development"),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_PATH: z.string().default("data/quotes.sqlite"),
  APP_VERSION: z.string().optional(),

  // Tool + admin auth. *_PREVIOUS keeps the old value valid during a rotation.
  TOOL_SECRET: z.string().min(24),
  TOOL_SECRET_PREVIOUS: z.string().min(24).optional(),
  ADMIN_SECRET: z.string().min(24).optional(),
  OPS_USER: z.string().min(3).optional(),
  OPS_PASSWORD: z.string().min(12).optional(),

  // PII protection.
  LICENSE_HMAC_KEY: z.string().min(16).optional(),
  DATA_ENCRYPTION_KEY: base64Key32.optional(),
  DATA_ENCRYPTION_KEY_PREVIOUS: base64Key32.optional(),

  // ElevenLabs.
  ELEVENLABS_API_KEY: z.string().optional(),
  ELEVENLABS_AGENT_ID: z.string().optional(),
  ELEVENLABS_WEBHOOK_SECRET: z.string().optional(),
  ELEVENLABS_WEBHOOK_SECRET_PREVIOUS: z.string().optional(),
  INITIATION_SECRET: z.string().min(24).optional(),

  // Alerting: Telegram for everything, a phone call for critical (with cooldowns and quiet hours).
  ALERTS_DISABLED: z.string().optional(),
  TELEGRAM_BOT_TOKEN: z.string().optional(),
  TELEGRAM_CHAT_ID: z.string().optional(),
  TWILIO_ACCOUNT_SID: z.string().optional(),
  TWILIO_AUTH_TOKEN: z.string().optional(),
  ALERT_VOICE_FROM: z.string().optional(),
  ALERT_VOICE_TO: z.string().optional(),
  ALERT_QUIET_HOURS: z.string().default("22-7"), // America/New_York; voice escalation suppressed, Telegram still sent
  PUBLIC_BASE_URL: z.string().default("https://quoteline.maxharar.com"),

  // Backups (S3-compatible bucket).
  BACKUP_BUCKET: z.string().optional(),
  BACKUP_ENDPOINT: z.string().optional(),
  BACKUP_REGION: z.string().default("auto"),
  BACKUP_ACCESS_KEY_ID: z.string().optional(),
  BACKUP_SECRET_ACCESS_KEY: z.string().optional(),
  BACKUP_RETENTION_DAYS: z.coerce.number().int().positive().default(14),
  BACKUP_VIRTUAL_HOSTED: z.string().optional(), // "true" for buckets that require virtual-host-style URLs (Railway)

  // PII retention.
  RETENTION_MODE: z.enum(["dry-run", "enforce"]).default("dry-run"),
  RETENTION_DAYS_LIVE: z.coerce.number().int().positive().default(30),
  RETENTION_DAYS_EVAL: z.coerce.number().int().positive().default(7),

  // External canary dead-man's switch.
  CANARY_SECRET: z.string().min(24).optional(),
  CANARY_MAX_SILENCE_HOURS: z.coerce.number().positive().default(3),

  TOOL_TIMEOUT_MS: z.coerce.number().int().positive().default(4000),
});

export type Config = z.infer<typeof schema> & { production: boolean; quietHours: [number, number] | null };

/** Secrets that must exist before a production process may serve traffic. */
const REQUIRED_IN_PRODUCTION = ["ADMIN_SECRET", "OPS_USER", "OPS_PASSWORD", "LICENSE_HMAC_KEY", "DATA_ENCRYPTION_KEY"] as const;

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`invalid configuration: ${issues}`);
  }
  const cfg = parsed.data;
  const production = cfg.NODE_ENV === "production";
  if (production) {
    const missing = REQUIRED_IN_PRODUCTION.filter((k) => !cfg[k]);
    if (missing.length) throw new Error(`missing required production secrets: ${missing.join(", ")}`);
  }
  const m = cfg.ALERT_QUIET_HOURS.match(/^(\d{1,2})-(\d{1,2})$/);
  return { ...cfg, production, quietHours: m ? [Number(m[1]), Number(m[2])] : null };
}
