#!/usr/bin/env bun
// External canary (run hourly by GitHub Actions, outside Railway):
//   1. /health and /ready on the public URL (TLS, routing, process, database)
//   2. a real ElevenLabs WebSocket conversation: the agent must initialize and speak its first
//      message (catches agent-config breakage like the missing-dynamic-variable outage)
//   3. a heartbeat to the server, which feeds the server-side dead-man's switch
// Retries once before declaring failure; on failure it alerts (Telegram + phone call) and exits 1.

import { alertFromEnv } from "./alert";

const BASE = (process.env.CANARY_BASE_URL ?? "https://quoteline.maxharar.com").replace(/\/$/, "");
const AGENT_ID = process.env.ELEVENLABS_AGENT_ID ?? (await Bun.file(new URL("../agent/deployed.json", import.meta.url)).json()).agent_id;

async function probeHttp(): Promise<string | null> {
  for (const path of ["/health", "/ready"]) {
    const res = await fetch(`${BASE}${path}`, { signal: AbortSignal.timeout(10_000) }).catch((e) => e as Error);
    if (res instanceof Error) return `${path}: ${res.message}`;
    if (res.status !== 200) return `${path}: HTTP ${res.status}`;
  }
  return null;
}

async function probeAgent(): Promise<string | null> {
  const key = process.env.ELEVENLABS_API_KEY;
  if (!key) return "ELEVENLABS_API_KEY not set";
  const signed = (await fetch(`https://api.elevenlabs.io/v1/convai/conversation/get-signed-url?agent_id=${AGENT_ID}`, { headers: { "xi-api-key": key }, signal: AbortSignal.timeout(10_000) })
    .then((r) => r.json())
    .catch(() => ({}))) as { signed_url?: string };
  if (!signed.signed_url) return "could not get a signed conversation URL";
  return await new Promise<string | null>((resolve) => {
    const ws = new WebSocket(signed.signed_url!);
    const timer = setTimeout(() => {
      ws.close();
      resolve("agent did not speak within 15s");
    }, 15_000);
    ws.onopen = () => ws.send(JSON.stringify({ type: "conversation_initiation_client_data", dynamic_variables: { canary: "true" } }));
    ws.onmessage = (e) => {
      const m = JSON.parse(String(e.data));
      if (m.type === "ping") ws.send(JSON.stringify({ type: "pong", event_id: m.ping_event?.event_id }));
      if (m.type === "agent_response" && m.agent_response_event?.agent_response) {
        clearTimeout(timer);
        ws.close();
        resolve(null);
      }
    };
    ws.onclose = (e) => {
      if (e.code !== 1000 && e.code !== 1005) {
        clearTimeout(timer);
        resolve(`agent connection closed: ${e.code} ${e.reason}`);
      }
    };
  });
}

async function heartbeat() {
  if (!process.env.CANARY_SECRET) return;
  await fetch(`${BASE}/canary/heartbeat`, { method: "POST", headers: { "x-canary-secret": process.env.CANARY_SECRET }, signal: AbortSignal.timeout(10_000) }).catch(() => {});
}

async function once(): Promise<string | null> {
  return (await probeHttp()) ?? (await probeAgent());
}

let failure = await once();
if (failure) {
  console.log(`first attempt failed (${failure}); retrying in 30s`);
  await Bun.sleep(30_000);
  failure = await once();
}
if (failure) {
  console.error(`CANARY FAILED: ${failure}`);
  await alertFromEnv({ key: "canary", severity: "critical", title: `Canary failed: ${failure}`, detail: `${BASE} · agent ${AGENT_ID}` });
  process.exit(1);
}
await heartbeat();
console.log("canary ok: health, readiness, and agent first message");
