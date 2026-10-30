import { AGENT_PERSONA_NAME, BRAND_NAME } from "../brand";
import type { CallRow, Repo } from "../db";
import { stateConfig } from "../rating/rateTable";
import type { CallMeta } from "./callMeta";
import { michiganFacts, MI_FORM_NOTE, MI_PROOF_NOTE, parseRating, utc } from "./summary";
import type { Conversation } from "./transcript";
import { METRIC_ALERTS, quantile, type CallMetrics } from "../ops/callMetrics";

const parseMetrics = (json: string | null | undefined): CallMetrics | null => {
  if (!json) return null;
  try {
    return JSON.parse(json) as CallMetrics;
  } catch {
    return null;
  }
};
const secs = (n: number | null) => (n === null ? "—" : `${n.toFixed(2)}s`);

/** One call's quality counts, with the alert thresholds highlighted. */
function metricsCard(m: CallMetrics): string {
  const warn = (bad: boolean, v: string) => (bad ? `<span class="warning">${v}</span>` : v);
  return `<table><tr><th>Caller turns</th><th>Empty</th><th>One-word</th><th>Re-asks</th><th>Never finalized</th><th>Stalls</th><th>Interruptions</th><th>Response delay p50 / p90</th></tr>
<tr><td>${m.caller_turns}</td><td>${m.empty_turns}</td><td>${m.short_turns}</td><td>${warn(m.reasks >= METRIC_ALERTS.reasks, String(m.reasks))}</td><td>${warn(m.unfinalized_turns >= METRIC_ALERTS.unfinalizedTurns, String(m.unfinalized_turns))}</td><td>${warn(m.stalls > 0, String(m.stalls))}</td><td>${m.interruptions}</td><td>${secs(m.latency_p50)} / ${warn(m.latency_p90 !== null && m.latency_p90 > METRIC_ALERTS.latencyP90Secs, secs(m.latency_p90))}</td></tr></table>`;
}

/** Rolling quality summary over recent live calls. */
function qualitySummary(rows: { metrics_json: string }[]): string {
  const ms = rows.map((r) => parseMetrics(r.metrics_json)).filter((m): m is CallMetrics => Boolean(m));
  if (!ms.length) return '<p class="muted">No call metrics yet. They appear after the next live call.</p>';
  const sum = (k: keyof CallMetrics) => ms.reduce((s, m) => s + (Number(m[k]) || 0), 0);
  const turns = sum("caller_turns");
  const rate = (n: number) => (turns ? `${((100 * n) / turns).toFixed(1)}%` : "—");
  const p90s = ms.map((m) => m.latency_p90).filter((v): v is number => v !== null);
  return `<table><tr><th>Calls</th><th>Caller turns</th><th>Empty</th><th>Never finalized</th><th>Re-asks per call</th><th>Calls with a stall</th><th>Reached a price</th><th>Median of call p90 delay</th></tr>
<tr><td>${ms.length}</td><td>${turns}</td><td>${rate(sum("empty_turns"))}</td><td>${rate(sum("unfinalized_turns"))}</td><td>${(sum("reasks") / ms.length).toFixed(1)}</td><td>${ms.filter((m) => m.stalls > 0).length}</td><td>${ms.filter((m) => m.reached_quote).length}</td><td>${secs(quantile(p90s, 0.5))}</td></tr></table>`;
}

const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);
// Whole dollars when there are no cents; Michigan totals can end in .50.
const usd = (n: number | null) => (n === null ? "—" : n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: n % 1 ? 2 : 0 }));
const dur = (s: number | null | undefined) => (s === null || s === undefined ? "—" : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`);
const mmss = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

/** A table, or a short "None yet." instead of an empty grid. */
const tableOrNone = (head: string, rows: string[]) => (rows.length ? `<table>${head}\n${rows.join("")}</table>` : '<p class="muted">None yet.</p>');

/** An "open" quote whose call ended (or went quiet for 30+ minutes) isn't open; it was left unfinished. */
export function statusLabel(status: string, updatedAt: string, ended: boolean, now = Date.now()): string {
  const stale = now - new Date(updatedAt).getTime() > 30 * 60_000;
  return status === "open" && (ended || stale) ? "incomplete" : status;
}

/** "OK", or "Refer: dui within 3 years, license not valid", instead of raw JSON. */
export function eligibilityText(json: string): string {
  try {
    const e = JSON.parse(json) as { status?: string; reasons?: string[] };
    if (e.status !== "REFER") return e.status ?? "unknown";
    return `Refer: ${(e.reasons ?? []).map((r) => r.toLowerCase().replaceAll("_", " ").replace(/\b3y\b/, "3 years")).join(", ")}`;
  } catch {
    return json;
  }
}

const STYLE = `
:root{color-scheme:light dark;--bg:#f6f6f3;--card:#fff;--ink:#15171c;--muted:#5f6672;--line:#e3e3dc;--accent:#1f5eff;--ok:#0f7b3f;--bad:#b42318;--warn:#a15c07;--agent:#eef2ff;--caller:#f1f5f2;--tool:#f7f5ee}
@media (prefers-color-scheme:dark){:root{--bg:#0e1014;--card:#161920;--ink:#eceef2;--muted:#98a0ae;--line:#272c36;--accent:#7aa2ff;--ok:#4cc38a;--bad:#ff7a6e;--warn:#f5b45b;--agent:#1b2236;--caller:#18241d;--tool:#22201a}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:1100px;margin:0 auto;padding:28px 16px 64px}a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}
h1{font-size:24px;margin:0 0 4px;letter-spacing:-.02em}h2{font-size:16px;margin:24px 0 8px}.muted{color:var(--muted)}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px;margin:18px 0}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px;overflow-x:auto}
.n{font-size:26px;font-weight:700;letter-spacing:-.02em}.l{color:var(--muted);font-size:12px;text-transform:uppercase;letter-spacing:.04em}
table{width:100%;border-collapse:collapse;font-size:13.5px}td,th{padding:7px 6px;border-bottom:1px solid var(--line);text-align:left;white-space:nowrap}th{color:var(--muted);font-weight:600}
.pill{display:inline-block;padding:1px 8px;border-radius:99px;font-size:12px;font-weight:600;border:1px solid currentColor}
.applied,.done,.success{color:var(--ok)}.quoted{color:var(--accent)}.referred,.transferred,.warning{color:var(--warn)}.open,.unknown{color:var(--muted)}.err,.failed,.failure,.initiation_failed,.critical{color:var(--bad)}
pre{white-space:pre-wrap;font-size:12px;margin:0}
.chat{display:flex;flex-direction:column;gap:8px}
.turn{max-width:78%;padding:9px 12px;border-radius:14px;border:1px solid var(--line)}
@media (max-width:600px){.turn{max-width:92%}}
.turn.agent{align-self:flex-start;background:var(--agent);border-top-left-radius:4px}
.turn.user{align-self:flex-end;background:var(--caller);border-top-right-radius:4px}
.who{font-size:11.5px;color:var(--muted);font-weight:600;letter-spacing:.02em;margin-bottom:2px}
.tool{align-self:flex-start;max-width:90%;font:12px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace;background:var(--tool);border:1px dashed var(--line);border-radius:8px;padding:6px 9px;color:var(--muted)}
.tool b{color:var(--ink)}
audio{width:100%;margin-top:6px}
`;

const page = (title: string, body: string) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>${esc(title)}</title><style>${STYLE}</style></head><body><main>${body}</main></body></html>`;

function evalBadges(json: string | null): string {
  if (!json) return '<span class="muted">—</span>';
  const r = JSON.parse(json) as Record<string, string | null>;
  return Object.entries(r)
    .map(([k, v]) => `<span class="${esc(v ?? "unknown")}" title="${esc(k)}: ${esc(v)}">${v === "success" ? "✓" : v === "failure" ? "✗" : "?"}</span>`)
    .join(" ");
}

function callsTable(calls: CallRow[]): string {
  if (!calls.length) return '<p class="muted">No live phone calls recorded yet. Outcomes arrive from ElevenLabs after each call ends.</p>';
  return `<table><tr><th>Ended (UTC)</th><th>Caller</th><th>Length</th><th>Status</th><th>Ended by</th><th>Policy checks</th></tr>${calls
    .map(
      (c) => `<tr><td><a href="/ops/quote/${encodeURIComponent(c.conversation_id)}">${esc(c.received_at.slice(5, 16).replace("T", " "))}</a></td><td>${esc(c.caller_phone ?? "—")}</td><td>${dur(c.duration_secs)}</td><td><span class="pill ${esc(c.status ?? "unknown")}">${esc(c.status ?? "—")}</span>${c.error ? ` <span class="err">${esc(c.error)}</span>` : ""}</td><td class="muted">${esc(c.termination_reason ?? "—")}</td><td>${evalBadges(c.evaluation_json)}</td></tr>`,
    )
    .join("")}</table>`;
}

export function renderOpsIndex(repo: Repo, opts: { tag?: string; elevenAgentId?: string }) {
  const tag = opts.tag ?? "live";
  const quotes = repo.db
    .query<Record<string, any>, [string]>(
      `SELECT q.*, a.app_number, a.applicant_name,
         (SELECT COUNT(*) FROM call_events e WHERE e.quote_id=q.id) AS tool_calls,
         (SELECT COUNT(*) FROM call_events e WHERE e.quote_id=q.id AND e.ok=0) AS tool_errors
       FROM quotes q LEFT JOIN applications a ON a.quote_id=q.id
       WHERE q.eval_tag LIKE ? || '%' ORDER BY q.created_at DESC LIMIT 200`,
    )
    .all(tag);
  const lat = repo.db
    .query<{ ms: number }, [string]>(`SELECT e.ms FROM call_events e JOIN quotes q ON q.id=e.quote_id WHERE q.eval_tag LIKE ? || '%' AND e.tool <> 'save_vehicle' ORDER BY e.ms`)
    .all(tag)
    .map((r) => r.ms);
  const p = (q: number) => (lat.length ? lat[Math.min(lat.length - 1, Math.floor(q * lat.length))] : 0);
  const count = (s: string) => quotes.filter((q) => q.status === s).length;
  const evalRuns = repo.db.query<{ run: string; n: number }, []>("SELECT substr(eval_tag, 1, 20) run, COUNT(*) n FROM quotes WHERE eval_tag LIKE 'eval-%' GROUP BY run ORDER BY MAX(created_at) DESC LIMIT 6").all();
  const isLive = tag === "live";
  const calls = isLive ? repo.recentCalls(25) : [];
  const alerts = isLive ? repo.recentAlerts(10) : [];
  const access = isLive ? repo.recentAccess(10) : [];
  const meta = (k: string) => repo.getMeta(k);
  const backup = meta("backup_last") ? (JSON.parse(meta("backup_last")!) as { at: string; bytes: number; quotes: number }) : null;
  const retention = meta("retention_last") ? (JSON.parse(meta("retention_last")!) as { at: string; mode: string }) : null;
  const heartbeat = meta("canary_last_heartbeat");

  const rows = quotes
    .map(
      (q) => `<tr>
  <td><a href="/ops/quote/${encodeURIComponent(q.id)}">${esc(q.created_at.slice(5, 16).replace("T", " "))}</a></td>
  <td>${esc(q.applicant_name ?? q.caller_name ?? "—")}${q.applicant_name ? ' <span class="applied" title="spelling confirmed by the caller">✓</span>' : ""}</td><td>${esc(q.state ?? "")} ${q.state === "MI" && q.garaging_city ? `${esc(q.garaging_city)} <span class="muted">${esc(q.zip ?? "—")}</span>` : esc(q.zip ?? "—")}</td>
  <td>${((s) => `<span class="pill ${esc(s)}">${esc(s)}</span>`)(statusLabel(q.status, q.updated_at, false))}${q.transfer_reason ? ` <span class="muted">${esc(q.transfer_reason)}</span>` : ""}</td>
  <td>${usd(q.six_month_premium)}</td>
  <td>${q.app_number ? `<a href="/q/${esc(q.app_number)}">${esc(q.app_number)}</a>` : "—"}</td>
  <td>${q.tool_calls}${q.tool_errors ? ` <span class="err">(${q.tool_errors} err)</span>` : ""}</td></tr>`,
    )
    .join("");

  return page(
    `Quote line ops`,
    `<h1>${esc(BRAND_NAME)} · Quote line ops</h1>
<div class="muted">Demo environment · synthetic rates · view: <b>${esc(tag.startsWith("eval-") ? "eval run " + tag.slice(5, 20) : tag)}</b> · <a href="/ops">live calls</a>${evalRuns.length ? " · eval runs: " + evalRuns.map((r) => `<a href="/ops?tag=${encodeURIComponent(r.run)}">${esc(r.run.slice(5))} (${r.n})</a>`).join(" · ") : ""}</div>
<div class="stats">
  <div class="card"><div class="l">Quotes</div><div class="n">${quotes.length}</div></div>
  <div class="card"><div class="l">Priced</div><div class="n">${count("quoted") + count("applied")}</div></div>
  <div class="card"><div class="l">Applications</div><div class="n">${count("applied")}</div></div>
  <div class="card"><div class="l">To a human</div><div class="n">${count("transferred") + count("referred")}</div></div>
  <div class="card"><div class="l">Tool p50 / p95</div><div class="n">${p(0.5)}<span class="muted" style="font-size:15px">ms</span> / ${p(0.95)}<span class="muted" style="font-size:15px">ms</span></div></div>
</div>
${isLive ? `<h2>Call quality · last ${Math.min(50, repo.recentCallMetrics(50).length)} live calls</h2><div class="card">${qualitySummary(repo.recentCallMetrics(50))}</div>` : ""}
${isLive ? `<h2>Live calls</h2><div class="card">${callsTable(calls)}</div>` : ""}
<h2>Quotes</h2>
<div class="card"><table><tr><th>Started (UTC)</th><th>Caller</th><th>Garaged</th><th>Status</th><th>6-mo</th><th>Application</th><th>Tool calls</th></tr>${rows || `<tr><td colspan="7" class="muted">No quotes yet.</td></tr>`}</table></div>
${
  isLive
    ? `<h2>System</h2><div class="card"><table>
<tr><td>Last backup</td><td>${backup ? `${esc(backup.at.slice(0, 16).replace("T", " "))} UTC · ${(backup.bytes / 1024).toFixed(0)} KB · ${backup.quotes} quotes` : '<span class="warning">none yet</span>'}</td></tr>
<tr><td>Last retention run</td><td>${retention ? `${esc(retention.at.slice(0, 16).replace("T", " "))} UTC · ${esc(retention.mode)}` : '<span class="muted">not yet</span>'}</td></tr>
<tr><td>Canary heartbeat</td><td>${heartbeat ? `${esc(heartbeat.slice(0, 16).replace("T", " "))} UTC` : '<span class="muted">none yet</span>'}</td></tr>
</table></div>
<h2>Recent alerts</h2><div class="card">${alerts.length ? `<table><tr><th>When (UTC)</th><th>Severity</th><th>Alert</th><th>Sent via</th></tr>${alerts.map((a) => `<tr><td>${esc(a.created_at.slice(5, 16).replace("T", " "))}</td><td class="${esc(a.severity)}">${esc(a.severity)}</td><td style="white-space:normal">${esc(a.title)}</td><td>${esc(a.channels)}</td></tr>`).join("")}</table>` : '<p class="muted">No alerts.</p>'}</div>
<h2>Access log</h2><div class="card"><table><tr><th>When (UTC)</th><th>Who</th><th>Request</th><th>Status</th><th>IP</th></tr>${access.map((a) => `<tr><td>${esc(a.created_at.slice(5, 19).replace("T", " "))}</td><td>${esc(a.principal ?? "—")}</td><td>${esc(a.method)} ${esc(a.path)}</td><td class="${a.status >= 400 ? "err" : ""}">${a.status}</td><td class="muted">${esc(a.ip)}</td></tr>`).join("")}</table></div>`
    : ""
}`,
  );
}

function renderConversation(c: Conversation | null | undefined, id: string): string {
  if (c?.unavailable) return '<p class="muted">Transcript temporarily unavailable from ElevenLabs. Refresh to retry.</p>';
  if (!c) return '<p class="muted">Conversation not available (not a live call, or older than the 30-day retention window).</p>';
  const items: string[] = [];
  for (const t of c.turns) {
    if (t.message.trim()) {
      items.push(`<div class="turn ${t.role}"><div class="who">${t.role === "agent" ? esc(AGENT_PERSONA_NAME) : "Caller"} · ${mmss(t.secs)}</div>${esc(t.message)}</div>`);
    }
    for (const tool of t.tools) items.push(`<div class="tool">→ <b>${esc(tool.name)}</b>(${esc(tool.args)})</div>`);
    for (const r of t.results) items.push(`<div class="tool">← <b>${esc(r.name)}</b> <span class="${r.ok ? "applied" : "err"}">${r.ok ? "ok" : "error"}</span>${r.latencyMs !== null ? ` · ${r.latencyMs} ms` : ""} · ${esc(r.summary)}</div>`);
  }
  return `${c.hasAudio ? `<audio controls preload="metadata" src="/ops/quote/${encodeURIComponent(id)}/audio"></audio>` : ""}<div class="chat" style="margin-top:10px">${items.join("") || '<p class="muted">No turns.</p>'}</div>`;
}

export function renderOpsQuote(repo: Repo, id: string, opts: { elevenAgentId?: string; meta?: CallMeta | null; conversation?: Conversation | null }) {
  const q = repo.getQuote(id);
  const call = repo.recentCalls(500, true).find((c) => c.conversation_id === id) ?? null;
  if (!q && !call && !opts.conversation) return null;
  const app = q ? repo.applicationByQuote(id) : null;
  const stored = q ? parseRating(q.rating_json) : null;
  const rating = stored?.result ?? null;
  const mi = q ? michiganFacts(q, stored) : null;
  // Same lawsuit line the summary page shows: the tort election if the state has one, else the state's default.
  const lawsuit = q?.tort_option ? `${q.tort_option} tort` : q?.state ? (stateConfig(q.state)?.lawsuitNote ?? "") : "";
  const events = q ? (repo.events(id) as { tool: string; ok: number; error: string | null; ms: number; created_at: string }[]) : [];
  const callback = q?.caller_phone ?? opts.meta?.callerPhone ?? call?.caller_phone ?? null;
  const length = opts.meta?.durationSecs ?? opts.conversation?.durationSecs ?? call?.duration_secs ?? null;
  const ended = opts.meta?.termination ?? call?.termination_reason ?? null;
  const title = app?.applicant_name ?? q?.caller_name ?? "Unknown caller";

  return page(
    `Call ${id}`,
    `<a href="/ops${q && q.eval_tag !== "live" ? `?tag=${encodeURIComponent(q.eval_tag)}` : ""}">← all calls</a>
<h1 style="margin-top:10px">${esc(title)}${app?.applicant_name ? ' <span class="applied" title="spelling confirmed by the caller">✓</span>' : ""} ${q ? ((s) => `<span class="pill ${esc(s)}">${esc(s)}</span>`)(statusLabel(q.status, q.updated_at, Boolean(ended))) : ""}</h1>
<div class="muted">${esc(id)}${q ? ` · ${esc(q.created_at)} · ${esc(q.state ?? "")} ZIP ${esc(q.zip ?? "—")}${mi ? ` · garaged in ${mi.city ? esc(mi.city) : "—"}` : ""} · territory ${esc(q.territory ?? "—")}${mi?.territoryLabel ? ` (${esc(mi.territoryLabel)})` : ""}${lawsuit ? ` · ${esc(lawsuit)}` : ""}` : ""}</div>
<p><b>Callback:</b> ${callback ? `<a href="tel:${esc(callback)}">${esc(callback)}</a>` : '<span class="muted">no caller ID (not a phone call)</span>'} · call length ${dur(length)}${ended ? ` · ended: ${esc(ended)}` : ""}${call?.evaluation_json ? ` · policy checks ${evalBadges(call.evaluation_json)}` : ""}</p>
${app ? `<p>Application <a href="/q/${esc(app.app_number)}">${esc(app.app_number)}</a> · ${usd(app.six_month_premium)} / 6 mo</p>` : ""}
${
  mi
    ? `<p><b>PIP medical:</b> ${mi.pipLabel ? esc(mi.pipLabel) : '<span class="muted">not chosen yet</span>'}${
        mi.restricted ? ` · eligibility and disclosure confirmed ${mi.confirmedAt ? esc(utc(mi.confirmedAt)) : '<span class="warning">time not recorded</span>'}` : ""
      }</p>
${mi.restricted ? `<p class="muted">${MI_PROOF_NOTE}</p>` : ""}<p class="muted">${MI_FORM_NOTE}</p>`
    : ""
}
${q?.eligibility_json ? `<p class="muted">Eligibility: ${esc(eligibilityText(q.eligibility_json))}</p>` : ""}
${q?.consent_status ? `<p><b>Recording:</b> ${q.consent_status === "declined" ? '<span class="warning">caller declined</span>' : "disclosed, caller continued"} ${q.consent_at ? `<span class="muted">· ${esc(utc(q.consent_at))} · disclosure ${esc(q.consent_version ?? "—")}</span>` : ""}</p>` : ""}
${((m) => (m ? `<h2>Call quality</h2><div class="card">${metricsCard(m)}</div>` : ""))(parseMetrics(repo.callMetrics(id)?.metrics_json))}
<h2>Conversation</h2><div class="card">${renderConversation(opts.conversation, id)}</div>
${
  q
    ? `<h2>Tool timeline</h2><div class="card"><table><tr><th>Time</th><th>Tool</th><th>Result</th><th>ms</th></tr>
${events.map((e) => `<tr><td>${esc(e.created_at.slice(11, 19))}</td><td>${esc(e.tool)}</td><td class="${e.ok ? "applied" : "err"}">${e.ok ? "ok" : esc(e.error)}</td><td>${e.ms}</td></tr>`).join("")}</table></div>
<h2>Drivers</h2><div class="card">${tableOrNone(
        "<tr><th>#</th><th>Name</th><th>DOB</th><th>License</th><th>Yrs</th><th>Self-reported (tix / at-fault / DUI)</th></tr>",
        repo.drivers(id).map((d) => `<tr><td>${d.driver_index}</td><td>${esc(d.first_name)} ${esc(d.last_name)}</td><td>${esc(d.dob)}</td><td>${d.license_last4 ? `${esc(d.license_state)} ••••${esc(d.license_last4)}` : `${esc(d.license_state)} <span class="warning">pending</span>`}</td><td>${d.years_licensed}</td><td>${d.sr_tickets_3y} / ${d.sr_at_fault_3y} / ${d.sr_dui_3y ? "yes" : "no"}</td></tr>`),
      )}</div>
<h2>Vehicles</h2><div class="card">${tableOrNone(
        "<tr><th>#</th><th>Vehicle</th><th>VIN</th><th>Use</th><th>Miles</th></tr>",
        repo.vehicles(id).map((v) => `<tr><td>${v.vehicle_index}</td><td>${v.year} ${esc(v.make)} ${esc(v.model)} (${esc(v.body_class)})</td><td>${esc(v.vin ?? "—")} ${v.vin_verified ? "✓" : ""}</td><td>${v.rideshare ? "rideshare" : esc(v.usage)}</td><td>${v.annual_miles.toLocaleString()}</td></tr>`),
      )}</div>
<h2>Reports</h2><div class="card">${tableOrNone(
        "<tr><th>Driver</th><th>Kind</th><th>Source</th><th>Payload</th></tr>",
        repo.reports(id).map((r) => `<tr><td>${r.driver_index}</td><td>${r.kind}</td><td>${esc(r.source)}</td><td><pre>${esc(r.payload_json)}</pre></td></tr>`),
      )}</div>
${rating ? `<h2>Rating worksheet · ${esc(rating.rateTableVersion)}</h2><div class="card"><table><tr><th>Veh</th><th>Cov</th><th>Base</th><th>Factors</th><th>Premium</th></tr>
${rating.lines.map((l) => `<tr><td>${l.vehicle}</td><td>${l.coverage}</td><td>${usd(l.base)}</td><td style="white-space:normal">${l.factors.filter((f) => f.value !== 1).map((f) => `${esc(f.name)} ×${f.value}`).join(" · ")}</td><td>$${l.premium.toFixed(2)}</td></tr>`).join("")}
${rating.assessments.map((a) => `<tr><td colspan="4">${esc(a.name)}: ${usd(a.perVehicle)} × ${a.vehicles} vehicle${a.vehicles === 1 ? "" : "s"} = ${usd(a.amount)} <span class="muted">(included in the six-month price)</span></td><td>${usd(a.amount)}</td></tr>`).join("")}
<tr><td colspan="4">Policy: ${rating.policyDiscounts.map((d) => `${esc(d.name)} ×${d.value}`).join(" · ") || "—"} · fee $${rating.policyFee}</td><td><b>${usd(rating.sixMonthPremium)}</b></td></tr></table></div>` : ""}`
    : ""
}`,
  );
}
