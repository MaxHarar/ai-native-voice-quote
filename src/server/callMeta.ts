// Backfills call metadata (caller number, duration) from ElevenLabs for the ops console.
// Deliberately OFF the voice path: a missing caller ID can never break a live tool call.

export interface CallMeta {
  callerPhone: string | null;
  durationSecs: number | null;
  termination: string | null;
}

export async function fetchCallMeta(conversationId: string, apiKey: string | undefined, fetchImpl: typeof fetch = fetch): Promise<CallMeta | null> {
  if (!apiKey || !conversationId.startsWith("conv_")) return null;
  try {
    const res = await fetchImpl(`https://api.elevenlabs.io/v1/convai/conversations/${encodeURIComponent(conversationId)}`, {
      headers: { "xi-api-key": apiKey },
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) return null;
    const j = (await res.json()) as { metadata?: { call_duration_secs?: number; termination_reason?: string; phone_call?: { external_number?: string } } };
    return {
      callerPhone: j.metadata?.phone_call?.external_number ?? null,
      durationSecs: j.metadata?.call_duration_secs ?? null,
      termination: j.metadata?.termination_reason ?? null,
    };
  } catch {
    return null;
  }
}
