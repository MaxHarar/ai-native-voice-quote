#!/usr/bin/env bun
// Idempotently configures the ElevenLabs workspace for this line:
//   - post-call webhook (HMAC) with transcripts excluded at the source
//   - call-start (initiation) webhook for returning callers, authenticated by a secret header
// Run after a release that changes webhook behavior. Usage: bun scripts/configure-elevenlabs.ts

import { client, listAll } from "../agent/elevenlabs";

const BASE = (process.env.PUBLIC_BASE_URL ?? "https://quoteline.maxharar.com").replace(/\/$/, "");
const required = (k: string) => {
  const v = process.env[k];
  if (!v) throw new Error(`${k} is required`);
  return v;
};

const el = client();
const SECRET_NAME = "quote-line-initiation-secret";
const secrets = await listAll<{ secret_id: string; name: string }>(el, "/v1/convai/secrets", "secrets");
const existing = secrets.find((s) => s.name === SECRET_NAME);
const initiationSecret = required("INITIATION_SECRET");
let secretId: string;
if (existing) {
  await el.patch(`/v1/convai/secrets/${existing.secret_id}`, { type: "update", name: SECRET_NAME, value: initiationSecret });
  secretId = existing.secret_id;
} else {
  secretId = (await el.post<{ secret_id: string }>("/v1/convai/secrets", { type: "new", name: SECRET_NAME, value: initiationSecret })).secret_id;
}

const returning = process.env.RETURNING_CALLERS !== "0";
const settings = await el.patch<Record<string, unknown>>("/v1/convai/settings", {
  webhooks: { post_call_webhook_id: required("ELEVENLABS_WEBHOOK_ID"), events: ["transcript", "call_initiation_failure"], exclude_transcript: true },
  conversation_initiation_client_data_webhook: returning ? { url: `${BASE}/webhooks/elevenlabs/initiation`, request_headers: { "x-initiation-secret": { secret_id: secretId } } } : null,
});
console.log(
  JSON.stringify(
    {
      post_call: settings.webhooks,
      initiation_webhook: (settings.conversation_initiation_client_data_webhook as { url?: string } | null)?.url ?? null,
      returning_callers: returning,
    },
    null,
    2,
  ),
);
