#!/usr/bin/env bun
// Idempotently deploys the quote-line agent to ElevenLabs: workspace secret → webhook tools → agent.
// Usage: bun run agent:deploy   (reads .env; TRANSFER_NUMBER optional until telephony is wired)

import { renderPolicy } from "../src/policy";
import {
  AGENT_LLM,
  AGENT_NAME,
  BACKUP_LLMS,
  EVALUATION_CRITERIA,
  FIRST_MESSAGE,
  SECRET_NAME,
  TOOLS,
  TRANSFER_CONDITION,
  TTS_MODEL,
  VOICE_ID,
  type ToolSpec,
} from "./config";
import { client, listAll, type Client } from "./elevenlabs";

const required = (k: string) => {
  const v = process.env[k];
  if (!v) throw new Error(`${k} is required`);
  return v;
};

async function upsertSecret(c: Client, value: string): Promise<string> {
  const secrets = await listAll<{ secret_id: string; name: string }>(c, "/v1/convai/secrets", "secrets");
  const existing = secrets.find((s) => s.name === SECRET_NAME);
  if (existing) {
    await c.patch(`/v1/convai/secrets/${existing.secret_id}`, { type: "update", name: SECRET_NAME, value });
    return existing.secret_id;
  }
  const created = await c.post<{ secret_id: string }>("/v1/convai/secrets", { type: "new", name: SECRET_NAME, value });
  return created.secret_id;
}

function toolConfig(t: ToolSpec, serverUrl: string, secretId: string) {
  return {
    type: "webhook",
    name: t.name,
    description: t.description,
    response_timeout_secs: t.timeoutSecs ?? 5,
    pre_tool_speech: t.preToolSpeech ?? "auto",
    api_schema: {
      url: `${serverUrl.replace(/\/$/, "")}/tools/${t.name}`,
      method: "POST",
      request_headers: { "x-tool-secret": { secret_id: secretId } },
      request_body_schema: {
        type: "object",
        description: t.description,
        properties: t.properties,
        required: t.required,
      },
    },
  };
}

async function upsertTools(c: Client, serverUrl: string, secretId: string): Promise<Record<string, string>> {
  const existing = await listAll<{ id: string; tool_config: { name: string; type: string } }>(c, "/v1/convai/tools", "tools");
  const ids: Record<string, string> = {};
  for (const t of TOOLS) {
    const cfg = toolConfig(t, serverUrl, secretId);
    const match = existing.find((e) => e.tool_config.type === "webhook" && e.tool_config.name === t.name);
    if (match) {
      await c.patch(`/v1/convai/tools/${match.id}`, { tool_config: cfg });
      ids[t.name] = match.id;
    } else {
      const created = await c.post<{ id: string }>("/v1/convai/tools", { tool_config: cfg });
      ids[t.name] = created.id;
    }
  }
  return ids;
}

export async function buildAgentBody(toolIds: string[], transferNumber: string | undefined) {
  const policy = await renderPolicy();

  const builtIns: Record<string, unknown> = {
    end_call: { type: "system", name: "end_call", description: "End the call after the caller says goodbye or has nothing else.", params: { system_tool_type: "end_call" } },
  };
  if (transferNumber) {
    if (!/^\+1\d{10}$/.test(transferNumber)) throw new Error("TRANSFER_NUMBER must be E.164 (+1XXXXXXXXXX)");
    builtIns.transfer_to_number = {
      type: "system",
      name: "transfer_to_number",
      description: "Transfer the caller to a licensed agent.",
      params: {
        system_tool_type: "transfer_to_number",
        enable_client_message: true,
        transfers: [{ transfer_destination: { type: "phone", phone_number: transferNumber }, condition: TRANSFER_CONDITION, transfer_type: "conference" }],
      },
    };
  }

  return {
    name: AGENT_NAME,
    tags: ["quote-line", "demo"],
    conversation_config: {
      agent: {
        first_message: FIRST_MESSAGE,
        language: "en",
        // Recording disclosure must be heard in full (PA is an all-party-consent state).
        disable_first_message_interruptions: true,
        prompt: {
          prompt: policy,
          llm: AGENT_LLM,
          temperature: 0,
          tool_ids: toolIds,
          built_in_tools: builtIns,
          backup_llm_config: { preference: "override", order: BACKUP_LLMS },
          cascade_timeout_seconds: 5,
          timezone: "America/New_York",
          ignore_default_personality: true,
        },
      },
      tts: { model_id: TTS_MODEL, voice_id: VOICE_ID, stability: 0.55, similarity_boost: 0.8, speed: 1.0 },
      asr: { quality: "high", keywords: ["VIN", "PIP", "DUI", "deductible", "collision", "comprehensive", "rideshare", "New Jersey"] },
      // spelling_patience stays on so callers aren't cut off mid-license-number; retranscribe_on_turn_timeout is the
      // safety net for the 2026-10-15 stall (a short "yes" after a digit read-back never finalized and the agent went
      // silent): at the 7s turn timeout, pending audio is re-transcribed and the agent answers instead of waiting.
      turn: {
        // 10s, not 7s: in field testing the 7s re-engagement cut callers off 4 times in one call as they started to answer.
        turn_timeout: 10,
        spelling_patience: "auto",
        // normal, measured: an audio A/B (evals/audio, 2026-10-15) found patient and eager stall on one-word answers as often
        // as normal (5-6 stalled lines per 2 calls each). No skip_turn tool either: in noise the agent took noise for a filler
        // sound, went silent, and the call died in dead air.
        turn_eagerness: "normal",
        retranscribe_on_turn_timeout: true,
        // A slow LLM response gets a short filler instead of dead air.
        soft_timeout_config: { timeout_seconds: 3, message: "One moment.", additional_soft_timeout_messages: ["Still with you, just a second."], max_soft_timeouts_per_generation: 2, disable_until_first_user_message: true },
      },
      conversation: { max_duration_seconds: 900 },
    },
    platform_settings: {
      privacy: { record_voice: true, retention_days: 30 },
      // Returning callers: the call-start webhook may override the first message and prompt for THIS call.
      overrides: {
        enable_conversation_initiation_client_data_from_webhook: process.env.RETURNING_CALLERS !== "0",
        conversation_config_override: { agent: { first_message: true, prompt: { prompt: true } } },
      },
      evaluation: { criteria: EVALUATION_CRITERIA.map((e) => ({ ...e, type: "prompt", use_knowledge_base: false })) },
    },
  };
}

async function upsertAgent(c: Client, body: Awaited<ReturnType<typeof buildAgentBody>>): Promise<string> {
  let agentId = process.env.ELEVENLABS_AGENT_ID;
  if (!agentId) {
    const agents = await listAll<{ agent_id: string; name: string }>(c, "/v1/convai/agents?page_size=100", "agents");
    agentId = agents.find((a) => a.name === AGENT_NAME)?.agent_id;
  }
  if (agentId) {
    await c.patch(`/v1/convai/agents/${agentId}`, body);
    return agentId;
  }
  return (await c.post<{ agent_id: string }>("/v1/convai/agents/create", body)).agent_id;
}

if (import.meta.main) {
  const c = client();
  const serverUrl = required("SERVER_URL");
  const secretId = await upsertSecret(c, required("TOOL_SECRET"));
  const toolIds = await upsertTools(c, serverUrl, secretId);
  const transfer = process.env.TRANSFER_NUMBER;
  const agentId = await upsertAgent(c, await buildAgentBody(Object.values(toolIds), transfer));

  const deployed = {
    agent_id: agentId,
    name: AGENT_NAME,
    llm: AGENT_LLM,
    backup_llms: BACKUP_LLMS,
    voice_id: VOICE_ID,
    tts_model: TTS_MODEL,
    server_url: serverUrl,
    tools: toolIds,
    transfer_configured: Boolean(transfer),
    deployed_at: new Date().toISOString(),
    // The commit this agent config came from: scripts/release.ts redeploys it on an automatic rollback. The latest
    // release tag is not good enough, because 936ef62's agent went live untagged (release aborted 2026-10-20).
    git_sha: Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: new URL(".", import.meta.url).pathname }).stdout.toString().trim() || undefined,
  };
  await Bun.write(new URL("./deployed.json", import.meta.url), JSON.stringify(deployed, null, 2) + "\n");
  console.log(JSON.stringify(deployed, null, 2));
}
