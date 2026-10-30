import { BRAND_NAME } from "../brand";
import type { ApplicationRow, DriverRow, QuoteRow, ReportRow, VehicleRow } from "../db";
import { stateConfig } from "../rating/rateTable";
import { PIP_RESTRICTED } from "../service";
import type { Assessment, Coverage, PackageId, PipMedical, RatingInput, RatingResult, State, Territory } from "../rating/types";

const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);
const usd = (n: number) => n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: n % 1 ? 2 : 0 });
const round2 = (n: number) => Math.round(n * 100) / 100;

/** "2026-10-15T03:12:44.123Z" → "2026-10-15 03:12 UTC". Not escaped: callers do that. */
export const utc = (ts: string) => `${ts.slice(0, 16).replace("T", " ")} UTC`;

/** What a quote's rating_json holds: `{ input, result }`. Rows rated before Michigan have no `assessments` on the result. */
export interface StoredRating {
  input?: Partial<RatingInput>;
  result: RatingResult;
  /** Pennsylvania: the same quote priced under the other tort option (the signed form decides). */
  otherTort?: { option: "limited" | "full"; sixMonthPremium: number; monthlyPayment: number | null };
}

export function parseRating(json: string | null): StoredRating | null {
  if (!json) return null;
  const stored = JSON.parse(json) as { input?: Partial<RatingInput>; result: Omit<RatingResult, "assessments"> & { assessments?: Assessment[] }; otherTort?: StoredRating["otherTort"] };
  return { input: stored.input, result: { ...stored.result, assessments: stored.result.assessments ?? [] }, ...(stored.otherTort ? { otherTort: stored.otherTort } : {}) };
}

/** PIP medical levels that rest on a household health-coverage claim: eligibility is confirmed on the call, proof and a signed form follow. */
const PIP_RESTRICTED_LEVELS: ReadonlySet<string> = new Set(Object.keys(PIP_RESTRICTED));

export const MI_FORM_NOTE = "Michigan PIP selection form required before issue.";
export const MI_PROOF_NOTE = "Proof of qualifying coverage and a signed Michigan PIP selection form required before issue.";

export interface MichiganFacts {
  city: string | null;
  /** Rating territory name, from the territory the quote was priced in (the saved one until it is). */
  territoryLabel: string | null;
  /** Null only when no election is recorded and nothing has been priced yet. */
  pipLabel: string | null;
  restricted: boolean;
  confirmedAt: string | null;
}

/** Everything Michigan-specific a quote page shows. Null for other states. */
export function michiganFacts(quote: QuoteRow, rating: StoredRating | null): MichiganFacts | null {
  if (quote.state !== "MI") return null;
  const cfg = stateConfig("MI");
  const territory = rating?.input?.territory ?? quote.territory;
  const key = quote.pip_medical ?? rating?.input?.pipMedical ?? null;
  const restricted = key !== null && PIP_RESTRICTED_LEVELS.has(key);
  // The engine prices a missing election as unlimited (MCL 500.3107c(4)), so a priced quote with none recorded says so.
  const pipLabel = key !== null ? (cfg.pipMedical?.[key as PipMedical]?.label ?? key) : rating ? `${cfg.pipMedical?.unlimited.label ?? "Unlimited"} (default, no election recorded)` : null;
  return {
    city: quote.garaging_city || null,
    territoryLabel: territory ? (cfg.territoryFactors[territory as Territory]?.label ?? null) : null,
    pipLabel,
    restricted,
    confirmedAt: restricted ? (quote.pip_confirmed_at ?? null) : null,
  };
}

function michiganCard(m: MichiganFacts): string {
  return `<div class="card" style="margin-bottom:20px"><h2 style="margin-top:0">Michigan details</h2><table>
<tr><th>Garaged in</th><td>${m.city ? esc(m.city) : "not provided"}${m.territoryLabel ? ` <span class="label">· ${esc(m.territoryLabel)}</span>` : ""}</td></tr>
<tr><th>PIP medical</th><td>${m.pipLabel ? esc(m.pipLabel) : "not chosen"}${
    m.restricted
      ? `<div class="label">Eligibility and disclosure confirmed ${m.confirmedAt ? esc(utc(m.confirmedAt)) : "(time not recorded)"}</div><div class="label">${MI_PROOF_NOTE}</div>`
      : ""
  }</td></tr>
</table><p class="label" style="margin:10px 0 0">${MI_FORM_NOTE}</p></div>`;
}

/** Pass-through charges (Michigan's catastrophic claims assessment) as their own lines before the total. Only when there are any. */
function priceBreakdown(r: RatingResult): string {
  if (!r.assessments.length) return "";
  const covered = round2(r.lines.reduce((s, l) => s + l.premium, 0));
  const assessed = round2(r.assessments.reduce((s, a) => s + a.amount, 0));
  const adjustments = round2(r.sixMonthPremium - r.policyFee - assessed - covered);
  const named = r.policyDiscounts.map((d) => d.name).join(", ");
  return `<h2>Price breakdown</h2><table>
<tr><td>Coverage premiums, all vehicles</td><td class="r">${usd(covered)}</td></tr>
<tr><td>Discounts, surcharges and rounding${named ? `<div class="label">${esc(named)}</div>` : ""}</td><td class="r">${usd(adjustments)}</td></tr>
<tr><td>Policy fee</td><td class="r">${usd(r.policyFee)}</td></tr>
${r.assessments
  .map(
    (a) =>
      `<tr><td>${esc(a.name)}<div class="label">${usd(a.perVehicle)} × ${a.vehicles} vehicle${a.vehicles === 1 ? "" : "s"} = ${usd(a.amount)} · included in the six-month price</div></td><td class="r">${usd(a.amount)}</td></tr>`,
  )
  .join("")}
<tr class="total"><td>Six-month premium</td><td class="r">${usd(r.sixMonthPremium)}</td></tr>
</table>`;
}

/** What the specialist still needs before the policy can issue, as stored on the application. */
export function pendingRequirements(app: ApplicationRow): string[] {
  if (!app.pending_requirements) return [];
  try {
    const v = JSON.parse(app.pending_requirements);
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}

export function renderSummary(x: { app: ApplicationRow; quote: QuoteRow; drivers: DriverRow[]; vehicles: VehicleRow[]; reports: ReportRow[] }) {
  const { app, quote } = x;
  const stored = parseRating(quote.rating_json);
  const rating = stored?.result ?? null;
  const mi = michiganFacts(quote, stored);
  const cfg = stateConfig((quote.state ?? "NJ") as State);
  const pkg = cfg.packages[(quote.package ?? "recommended") as PackageId];
  // A limit of "elected" (Michigan PIP) means the caller chose it: show the choice.
  const limitText = (c: Coverage) => (pkg.limits[c] === "elected" ? (mi?.pipLabel ?? "elected") : pkg.limits[c]);
  const stacked = rating?.lines.some((l) => l.factors.some((f) => f.name === "UM/UIM stacking")) ?? false;
  const lawsuit = quote.tort_option ? `${quote.tort_option === "limited" ? "Limited" : "Full"} tort` : cfg.lawsuitNote;
  const other = stored?.otherTort ?? null;
  const pending = pendingRequirements(app);
  const byCov = new Map<Coverage, number>();
  for (const l of rating?.lines ?? []) byCov.set(l.coverage, (byCov.get(l.coverage) ?? 0) + l.premium);

  const reportRows = x.reports
    .map((r) => {
      const p = JSON.parse(r.payload_json);
      const d = x.drivers.find((dd) => dd.driver_index === r.driver_index);
      const detail =
        r.kind === "MVR" ? `${p.status}, ${p.violations.length} violation(s)` : r.kind === "CLUE" ? `${p.claims.length} claim(s)` : p.continuousMonths === null ? "not verified" : `${p.continuousMonths} months continuous`;
      return `<tr><td>${esc(d?.first_name)}</td><td>${r.kind}</td><td>${esc(detail)}</td><td>${r.source === "default" ? "no record found" : "simulated vendor"}</td></tr>`;
    })
    .join("");

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(BRAND_NAME)} · ${esc(app.app_number)}</title>
<style>
:root{--bg:#f7f7f4;--card:#fff;--ink:#16181d;--muted:#5d6470;--line:#e4e4de;--accent:#1f5eff;--warn:#b54708;--warnbg:#fff4e5}
@media (prefers-color-scheme:dark){:root{--bg:#0f1115;--card:#171a21;--ink:#eceef2;--muted:#9aa2b1;--line:#2a2f3a;--accent:#7aa2ff;--warn:#ffb86b;--warnbg:#2a1f12}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:760px;margin:0 auto;padding:32px 16px 64px}
.brand{font-weight:700;letter-spacing:-.01em;color:var(--muted);font-size:14px;text-transform:uppercase}
h1{font-size:28px;margin:6px 0 4px;letter-spacing:-.02em}.sub{color:var(--muted);margin:0 0 20px}
.demo{background:var(--warnbg);color:var(--warn);border:1px solid currentColor;border-radius:10px;padding:10px 14px;font-weight:600;margin-bottom:20px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px;margin-bottom:20px}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:16px}
.big{font-size:32px;font-weight:700;letter-spacing:-.02em}.label{color:var(--muted);font-size:13px}
table{width:100%;border-collapse:collapse;font-size:14px}td,th{padding:8px 6px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}th{color:var(--muted);font-weight:600}
td.r{text-align:right;font-variant-numeric:tabular-nums}h2{font-size:17px;margin:24px 0 8px}
tr.total td{font-weight:700;border-top:2px solid var(--line)}
ul{margin:0;padding-left:18px}
</style></head><body><main>
<div class="brand">${esc(BRAND_NAME)}</div>
<h1>Application ${esc(app.app_number)}</h1>
<p class="sub">${esc(cfg.name)} · Received ${esc(app.created_at.slice(0, 16).replace("T", " "))} UTC · Pending specialist review · Rate table ${esc(rating?.rateTableVersion ?? "")}</p>
<div class="demo">DEMO: synthetic rates and simulated reports. This is not an offer of insurance, and no coverage is bound or active.</div>
<div class="grid">
  <div class="card"><div class="label">Six-month premium</div><div class="big">${usd(app.six_month_premium)}</div></div>
  <div class="card"><div class="label">${quote.monthly_payment ? "Monthly payment" : "Payment plan"}</div><div class="big">${quote.monthly_payment ? usd(quote.monthly_payment) : "Paid in full"}</div></div>
  <div class="card"><div class="label">Package</div><div class="big" style="font-size:22px">${esc(pkg.label)}</div>${lawsuit ? `<div class="label" style="margin-top:6px">${esc(lawsuit)}</div>` : ""}</div>
</div>
${other ? `<div class="card" style="margin-bottom:20px"><h2 style="margin-top:0">Tort options</h2><table><tr><th>Option</th><th class="r">Six-month premium</th><th class="r">Monthly</th></tr>
<tr><td>${esc(quote.tort_option === "limited" ? "Limited" : "Full")} tort <span class="label">· chosen on the call</span></td><td class="r">${usd(app.six_month_premium)}</td><td class="r">${quote.monthly_payment ? usd(quote.monthly_payment) : "n/a"}</td></tr>
<tr><td>${esc(other.option === "limited" ? "Limited" : "Full")} tort</td><td class="r">${usd(other.sixMonthPremium)}</td><td class="r">${other.monthlyPayment ? usd(other.monthlyPayment) : "n/a"}</td></tr>
</table><p class="label" style="margin:10px 0 0">The choice is final only on the signed Pennsylvania tort election form.</p></div>` : ""}${pending.length ? `<div class="card" style="margin-bottom:20px"><h2 style="margin-top:0">Needed before issue</h2><ul>${pending.map((p) => `<li>${esc(p)}</li>`).join("")}</ul></div>` : ""}
${mi ? michiganCard(mi) : ""}<div class="card"><h2 style="margin-top:0">Coverages</h2><table><tr><th>Coverage</th><th>Limit</th><th class="r">6-mo premium</th></tr>
${cfg.coverages
  .filter(({ code }) => pkg.limits[code] !== null && pkg.limits[code] !== undefined)
  .map(({ code: c, name }) => `<tr><td>${esc(name)}${c === "UM" && stacked ? " (stacked)" : ""}</td><td>${esc(limitText(c))}</td><td class="r">${usd(Math.round((byCov.get(c) ?? 0) * 100) / 100)}</td></tr>`)
  .join("")}
</table>
${rating ? priceBreakdown(rating) : ""}${rating ? `<h2>What moved the price</h2><ul>${rating.topFactors.map((f) => `<li>${esc(f.name)} ${f.direction} it (×${f.impact.toFixed(2)})</li>`).join("")}${rating.policyDiscounts.filter((d) => !rating.topFactors.some((f) => f.name === d.name)).map((d) => `<li>${esc(d.name)} lowers it (×${d.value.toFixed(2)})</li>`).join("")}</ul>` : ""}
</div>
<h2>Drivers</h2><div class="card"><table><tr><th>Driver</th><th>License</th><th>Licensed</th></tr>
${x.drivers.map((d) => `<tr><td>${esc(d.first_name)} ${esc(d.last_name[0])}.</td><td>${d.license_last4 ? `${esc(d.license_state)} ••••${esc(d.license_last4)}` : `${esc(d.license_state)} (pending)`}</td><td>${d.years_licensed} yrs</td></tr>`).join("")}
</table></div>
<h2>Vehicles</h2><div class="card"><table><tr><th>Vehicle</th><th>VIN</th><th>Use</th></tr>
${x.vehicles.map((v) => `<tr><td>${v.year} ${esc(v.make)} ${esc(v.model)}</td><td>${v.vin ? `${esc(v.vin.slice(0, 3))}…${esc(v.vin.slice(-4))} ${v.vin_verified ? "✓ decoded" : ""}` : "not provided"}</td><td>${v.rideshare ? "rideshare" : esc(v.usage)}, ${v.annual_miles.toLocaleString()} mi/yr</td></tr>`).join("")}
</table></div>
<h2>Reports run</h2><div class="card"><table><tr><th>Driver</th><th>Report</th><th>Result</th><th>Source</th></tr>${reportRows}</table></div>
</main></body></html>`;
}
