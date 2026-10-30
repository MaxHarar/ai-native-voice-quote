// Minimal typed client for the ElevenLabs Agents REST API (no SDK dependency).

const BASE = process.env.ELEVENLABS_API_BASE ?? "https://api.elevenlabs.io";

export class ElevenLabsError extends Error {
  constructor(readonly status: number, readonly body: string, readonly path: string) {
    super(`ElevenLabs ${status} on ${path}: ${body.slice(0, 600)}`);
  }
}

export function client(apiKey = process.env.ELEVENLABS_API_KEY) {
  if (!apiKey) throw new Error("ELEVENLABS_API_KEY is not set");
  async function req<T>(method: string, path: string, body?: unknown, timeoutMs = 30_000): Promise<T> {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { "xi-api-key": apiKey!, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    if (!res.ok) throw new ElevenLabsError(res.status, text, `${method} ${path}`);
    return (text ? JSON.parse(text) : {}) as T;
  }
  return {
    get: <T>(p: string) => req<T>("GET", p),
    post: <T>(p: string, b: unknown, t?: number) => req<T>("POST", p, b, t),
    patch: <T>(p: string, b: unknown) => req<T>("PATCH", p, b),
    del: <T>(p: string) => req<T>("DELETE", p),
  };
}
export type Client = ReturnType<typeof client>;

/** Follows next_cursor pagination for list endpoints shaped { <key>: [], next_cursor }. */
export async function listAll<T>(c: Client, path: string, key: string): Promise<T[]> {
  const out: T[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 20; page++) {
    const sep = path.includes("?") ? "&" : "?";
    const r: Record<string, unknown> & { next_cursor?: string | null } = await c.get(`${path}${cursor ? `${sep}cursor=${encodeURIComponent(cursor)}` : ""}`);
    out.push(...((r[key] as T[]) ?? []));
    cursor = r.next_cursor ?? null;
    if (!cursor) break;
  }
  return out;
}
