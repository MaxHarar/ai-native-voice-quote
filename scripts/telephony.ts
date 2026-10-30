#!/usr/bin/env bun
// One-shot telephony setup: get a Twilio number (existing TWILIO_PHONE_NUMBER, or buy a local one),
// import it into ElevenLabs via the native Twilio integration, and assign the quote-line agent.
// Usage: bun scripts/telephony.ts [--area-code 609]
//
// New Twilio accounts must have an approved Trust Hub primary customer profile (KYC) before buying
// US numbers; this script surfaces that error verbatim instead of failing silently.

import { parseArgs } from "node:util";
import { client } from "../agent/elevenlabs";

const { values: args } = parseArgs({ options: { "area-code": { type: "string", default: "609" } } });
const sid = process.env.TWILIO_ACCOUNT_SID;
const token = process.env.TWILIO_AUTH_TOKEN;
if (!sid || !token) throw new Error("TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN are required");

const twilio = async (path: string, init?: RequestInit) => {
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}${path}`, {
    ...init,
    headers: { authorization: "Basic " + Buffer.from(`${sid}:${token}`).toString("base64"), ...(init?.headers ?? {}) },
  });
  const json = (await res.json()) as any;
  if (!res.ok) throw new Error(`Twilio ${res.status}: ${json.message ?? JSON.stringify(json)}`);
  return json;
};

async function ensureNumber(): Promise<string> {
  if (process.env.TWILIO_PHONE_NUMBER) return process.env.TWILIO_PHONE_NUMBER;
  const owned = await twilio("/IncomingPhoneNumbers.json");
  const existing = owned.incoming_phone_numbers?.find((n: any) => n.friendly_name === "AI-Native Voice Quote (demo)");
  if (existing) return existing.phone_number;
  const avail = await twilio(`/AvailablePhoneNumbers/US/Local.json?AreaCode=${args["area-code"]}&VoiceEnabled=true&PageSize=1`);
  const pick = avail.available_phone_numbers?.[0]?.phone_number;
  if (!pick) throw new Error(`No numbers available in area code ${args["area-code"]}`);
  const bought = await twilio("/IncomingPhoneNumbers.json", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ PhoneNumber: pick, FriendlyName: "AI-Native Voice Quote (demo)" }),
  });
  console.log(`bought ${bought.phone_number}`);
  return bought.phone_number;
}

const number = await ensureNumber();
const deployedUrl = new URL("../agent/deployed.json", import.meta.url);
const deployed = await Bun.file(deployedUrl).json();
const el = client();

const list = await el.get<{ phone_number: string; phone_number_id: string }[]>("/v1/convai/phone-numbers");
let phoneId = list.find((p) => p.phone_number === number)?.phone_number_id;
if (phoneId) {
  await el.patch(`/v1/convai/phone-numbers/${phoneId}`, { agent_id: deployed.agent_id });
} else {
  const created = await el.post<{ phone_number_id: string }>("/v1/convai/phone-numbers", {
    phone_number: number,
    label: "AI-Native Voice Quote (demo)",
    provider: "twilio",
    sid,
    token,
    agent_id: deployed.agent_id,
  });
  phoneId = created.phone_number_id;
}

await Bun.write(deployedUrl, JSON.stringify({ ...deployed, phone_number_id: phoneId, phone_number_configured: true }, null, 2) + "\n");
console.log(JSON.stringify({ phone_number: number, phone_number_id: phoneId, agent_id: deployed.agent_id }, null, 2));
