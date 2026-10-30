import { AGENT_PERSONA_NAME, BRAND_NAME } from "./brand";

// The agent's policy, rendered once from policy/quote-line-policy.md. Shared by the agent deploy
// (the default prompt) and the server (the per-call prompt override for returning callers), so the
// two can never drift apart.

let cached: string | null = null;

export async function renderPolicy(): Promise<string> {
  if (cached) return cached;
  const raw = await Bun.file(new URL("../policy/quote-line-policy.md", import.meta.url)).text();
  cached = raw.replaceAll("{{BRAND}}", BRAND_NAME).replaceAll("{{PERSONA}}", AGENT_PERSONA_NAME);
  return cached;
}
