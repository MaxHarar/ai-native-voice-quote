import { describe, expect, test } from "bun:test";
import { TOOLS, type ToolSpec } from "../agent/config";
import { TOOL_SCHEMAS } from "../src/server/app";
import { fetchCallMeta } from "../src/server/callMeta";

// Executable contract between what the agent sends (agent/config.ts) and what the server accepts
// (zod schemas in src/server/app.ts). Drift here is a production outage: the LLM would call a tool
// the server rejects on every call.

type Prop = ToolSpec["properties"][string];

function sampleValue(name: string, p: Prop): unknown {
  if (p.dynamic_variable) return "conv_contract_test";
  if (p.enum) return p.enum[0];
  switch (p.type) {
    case "boolean":
      return true;
    case "integer":
    case "number":
      return name.includes("index") ? 1 : name === "year" ? 2020 : 3;
    default:
      if (name.includes("hash")) return "ABCDEF1234";
      if (name === "application_number") return "ANA-4829173";
      return name.includes("zip") ? "08540" : name.includes("date") ? "1990-01-01" : name.includes("state") ? "NJ" : "sample";
  }
}

const payloadFor = (t: ToolSpec, keys: string[]) => Object.fromEntries(keys.map((k) => [k, sampleValue(k, t.properties[k]!)]));

describe("agent ↔ server tool contract", () => {
  test("every agent tool has a server schema, and vice versa", () => {
    expect(TOOLS.map((t) => t.name).sort()).toEqual(Object.keys(TOOL_SCHEMAS).sort());
  });

  for (const t of TOOLS) {
    const schema = TOOL_SCHEMAS[t.name as keyof typeof TOOL_SCHEMAS];

    test(`${t.name}: a payload with only the agent's required params is accepted`, () => {
      const r = schema.safeParse(payloadFor(t, t.required));
      expect(r.success ? "ok" : JSON.stringify(r.error.issues)).toBe("ok");
    });

    test(`${t.name}: a payload with every agent param is accepted`, () => {
      const r = schema.safeParse(payloadFor(t, Object.keys(t.properties)));
      expect(r.success ? "ok" : JSON.stringify(r.error.issues)).toBe("ok");
    });

    test(`${t.name}: every enum value the agent may send is accepted`, () => {
      for (const [k, p] of Object.entries(t.properties)) {
        for (const v of p.enum ?? []) {
          const r = schema.safeParse({ ...payloadFor(t, t.required), [k]: v });
          expect(r.success ? "ok" : `${k}=${v}: ${JSON.stringify(r.error.issues)}`).toBe("ok");
        }
      }
    });

    // (The required-only payload test above already proves the server requires nothing the agent may omit.)
  }
});

// Release order is new server first while the previous agent is still live, so the server must keep accepting what that
// agent sends. The fixture is the agent's tool specs as deployed at 936ef62 (2026-10-20; lookup_application gained
// conversation_id and last_name), regenerated from agent/config.ts TOOLS, unchanged since. Refresh it after each agent
// deploy so it always describes the agent that will still be live while the next server ships.
describe("the previous live agent still works against this server", async () => {
  const OLD: ToolSpec[] = await Bun.file(new URL("./fixtures/agent-tools-936ef62.json", import.meta.url)).json();
  for (const t of OLD) {
    test(`${t.name}: the old agent's required-only and full payloads are accepted`, () => {
      const schema = TOOL_SCHEMAS[t.name as keyof typeof TOOL_SCHEMAS];
      expect(schema).toBeDefined();
      for (const keys of [t.required, Object.keys(t.properties)]) {
        const r = schema.safeParse(payloadFor(t, keys));
        expect(r.success ? "ok" : JSON.stringify(r.error.issues)).toBe("ok");
      }
    });
  }
});

describe("call metadata backfill (off the voice path)", () => {
  const ok = (body: unknown) => (async () => new Response(JSON.stringify(body))) as unknown as typeof fetch;

  test("reads caller number, duration, and termination from ElevenLabs", async () => {
    const meta = await fetchCallMeta("conv_1", "key", ok({ metadata: { call_duration_secs: 70, termination_reason: "end_call tool", phone_call: { external_number: "+10000000000" } } }));
    expect(meta).toEqual({ callerPhone: "+10000000000", durationSecs: 70, termination: "end_call tool" });
  });

  test("never throws: no key, non-call ids, HTTP errors, and network failures all return null", async () => {
    expect(await fetchCallMeta("conv_1", undefined, ok({}))).toBeNull();
    expect(await fetchCallMeta("sim_eval-x", "key", ok({}))).toBeNull();
    expect(await fetchCallMeta("conv_1", "key", (async () => new Response("no", { status: 500 })) as unknown as typeof fetch)).toBeNull();
    expect(await fetchCallMeta("conv_1", "key", (async () => { throw new Error("network"); }) as unknown as typeof fetch)).toBeNull();
  });
});
