#!/usr/bin/env bun
// Stateless alert sender for CI jobs (canary, release): Telegram, plus a phone call for critical
// alerts outside quiet hours. The server's own alerter adds cooldowns and caps; this path is for
// "the server itself may be down" situations, so it must not depend on the server.

import { inQuietHours } from "../src/ops/alerts";

export async function alertFromEnv(a: { key: string; severity: "critical" | "warning"; title: string; detail?: string }) {
  const env = process.env;
  const sent: string[] = [];
  if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) {
    const ok = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text: `${a.severity === "critical" ? "🚨" : "⚠️"} Quote line: ${a.title}${a.detail ? `\n\n${a.detail}` : ""}` }),
    }).then((r) => r.ok, () => false);
    if (ok) sent.push("telegram");
  }
  const quiet = (env.ALERT_QUIET_HOURS ?? "22-7").match(/^(\d{1,2})-(\d{1,2})$/);
  const isQuiet = quiet ? inQuietHours(new Date(), [Number(quiet[1]), Number(quiet[2])]) : false;
  if (a.severity === "critical" && !isQuiet && env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && env.ALERT_VOICE_FROM && env.ALERT_VOICE_TO) {
    const say = a.title.replace(/[<>&'"]/g, " ");
    const ok = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_ACCOUNT_SID}/Calls.json`, {
      method: "POST",
      headers: { authorization: "Basic " + Buffer.from(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`).toString("base64"), "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ To: env.ALERT_VOICE_TO, From: env.ALERT_VOICE_FROM, Twiml: `<Response><Say voice="Polly.Joanna">Alert from the A I native quote line. ${say}. Check Telegram for details.</Say></Response>` }),
    }).then((r) => r.ok, () => false);
    if (ok) sent.push("voice");
  }
  console.log(JSON.stringify({ alert: a.key, severity: a.severity, sent }));
  return sent;
}

if (import.meta.main) {
  const [severity, ...title] = process.argv.slice(2);
  await alertFromEnv({ key: "manual", severity: severity === "critical" ? "critical" : "warning", title: title.join(" ") || "Test alert" });
}
