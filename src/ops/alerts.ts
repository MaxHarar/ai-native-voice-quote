import type { Repo } from "../db";

// Alert routing chosen by the principal: Telegram for every alert; a phone call to his cell for
// critical ones. Storm control: per-key cooldowns, a daily cap on phone calls, and quiet hours
// (America/New_York) during which critical alerts go to Telegram only.

export type Severity = "critical" | "warning" | "info";

export interface AlertSettings {
  disabled: boolean;
  telegram?: { token: string; chatId: string };
  voice?: { accountSid: string; authToken: string; from: string; to: string };
  quietHours: [number, number] | null;
  telegramCooldownMs: number;
  voiceCooldownMs: number;
  voiceDailyCap: number;
}

export const DEFAULT_ALERT_TIMING = { telegramCooldownMs: 15 * 60_000, voiceCooldownMs: 2 * 3600_000, voiceDailyCap: 3 };

export interface AlertInput {
  /** Dedup key: the same key within its cooldown is suppressed. */
  key: string;
  severity: Severity;
  title: string;
  detail?: string;
}

export interface AlertResult {
  channels: string[];
  suppressed: string[];
}

type Fetch = typeof fetch;

const xml = (s: string) => s.replace(/[<>&'"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" })[c]!);

/** Hour of day in New York for quiet-hours checks (handles DST via Intl). */
export function nyHour(now: Date): number {
  return Number(new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", hourCycle: "h23" }).format(now));
}

export function inQuietHours(now: Date, quiet: [number, number] | null): boolean {
  if (!quiet) return false;
  const [start, end] = quiet;
  const h = nyHour(now);
  return start <= end ? h >= start && h < end : h >= start || h < end;
}

export class Alerter {
  constructor(
    private readonly repo: Repo,
    private readonly settings: AlertSettings,
    private readonly now: () => Date = () => new Date(),
    private readonly fetchImpl: Fetch = fetch,
    private readonly log: (l: Record<string, unknown>) => void = (l) => console.log(JSON.stringify(l)),
  ) {}

  private withinCooldown(key: string, channel: string, cooldownMs: number): boolean {
    const last = this.repo.lastAlertOn(key, channel);
    return !!last && this.now().getTime() - new Date(last).getTime() < cooldownMs;
  }

  async send(a: AlertInput): Promise<AlertResult> {
    const channels: string[] = [];
    const suppressed: string[] = [];
    if (this.settings.disabled) return { channels, suppressed: ["disabled"] };

    const tg = this.settings.telegram;
    if (tg) {
      if (this.withinCooldown(a.key, "telegram", this.settings.telegramCooldownMs)) suppressed.push("telegram:cooldown");
      else if (await this.telegram(tg, a)) channels.push("telegram");
    }

    const voice = this.settings.voice;
    if (voice && a.severity === "critical") {
      const dayAgo = new Date(this.now().getTime() - 24 * 3600_000).toISOString();
      if (inQuietHours(this.now(), this.settings.quietHours)) suppressed.push("voice:quiet-hours");
      else if (this.withinCooldown(a.key, "voice", this.settings.voiceCooldownMs)) suppressed.push("voice:cooldown");
      else if (this.repo.alertsOnChannelSince("voice", dayAgo) >= this.settings.voiceDailyCap) suppressed.push("voice:daily-cap");
      else if (await this.call(voice, a)) channels.push("voice");
    }

    this.repo.insertAlert({ key: a.key, severity: a.severity, title: a.title, detail: a.detail ?? null, channels: channels.join(",") || "none", created_at: this.now().toISOString() });
    this.log({ level: a.severity === "critical" ? "error" : "warn", message: "alert", key: a.key, title: a.title, channels, suppressed });
    return { channels, suppressed };
  }

  private async telegram(tg: { token: string; chatId: string }, a: AlertInput): Promise<boolean> {
    const icon = a.severity === "critical" ? "🚨" : a.severity === "warning" ? "⚠️" : "ℹ️";
    try {
      const res = await this.fetchImpl(`https://api.telegram.org/bot${tg.token}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: tg.chatId, text: `${icon} Quote line: ${a.title}${a.detail ? `\n\n${a.detail}` : ""}`, disable_web_page_preview: true }),
        signal: AbortSignal.timeout(5000),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  private async call(v: { accountSid: string; authToken: string; from: string; to: string }, a: AlertInput): Promise<boolean> {
    const say = xml(`Alert from the A I native quote line. ${a.title}. Check Telegram for details.`);
    const twiml = `<Response><Say voice="Polly.Joanna">${say}</Say><Pause length="1"/><Say voice="Polly.Joanna">Repeating. ${xml(a.title)}.</Say></Response>`;
    try {
      const res = await this.fetchImpl(`https://api.twilio.com/2010-04-01/Accounts/${v.accountSid}/Calls.json`, {
        method: "POST",
        headers: { authorization: "Basic " + Buffer.from(`${v.accountSid}:${v.authToken}`).toString("base64"), "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ To: v.to, From: v.from, Twiml: twiml }),
        signal: AbortSignal.timeout(8000),
      });
      return res.ok;
    } catch {
      return false;
    }
  }
}

export function alertSettingsFrom(cfg: {
  ALERTS_DISABLED?: string;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_CHAT_ID?: string;
  TWILIO_ACCOUNT_SID?: string;
  TWILIO_AUTH_TOKEN?: string;
  ALERT_VOICE_FROM?: string;
  ALERT_VOICE_TO?: string;
  quietHours: [number, number] | null;
}): AlertSettings {
  return {
    disabled: cfg.ALERTS_DISABLED === "1" || cfg.ALERTS_DISABLED === "true",
    telegram: cfg.TELEGRAM_BOT_TOKEN && cfg.TELEGRAM_CHAT_ID ? { token: cfg.TELEGRAM_BOT_TOKEN, chatId: cfg.TELEGRAM_CHAT_ID } : undefined,
    voice:
      cfg.TWILIO_ACCOUNT_SID && cfg.TWILIO_AUTH_TOKEN && cfg.ALERT_VOICE_FROM && cfg.ALERT_VOICE_TO
        ? { accountSid: cfg.TWILIO_ACCOUNT_SID, authToken: cfg.TWILIO_AUTH_TOKEN, from: cfg.ALERT_VOICE_FROM, to: cfg.ALERT_VOICE_TO }
        : undefined,
    quietHours: cfg.quietHours,
    ...DEFAULT_ALERT_TIMING,
  };
}
