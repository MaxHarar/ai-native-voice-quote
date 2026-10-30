import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { AGENT_PERSONA_NAME } from "../src/brand";
import { openDb, Repo } from "../src/db";
import { rate } from "../src/rating/engine";
import { stateConfig, territoryForMunicipality } from "../src/rating/rateTable";
import type { Coverage, PackageId, PipMedical, RatingInput, State, Territory } from "../src/rating/types";
import { renderOpsIndex, renderOpsQuote } from "../src/server/ops";
import { renderSummary } from "../src/server/summary";
import type { Conversation } from "../src/server/transcript";

// Michigan quote display on the gated summary page and the ops console.

const PROOF_NOTE = "Proof of qualifying coverage and a signed Michigan PIP selection form required before issue.";
const FORM_NOTE = "Michigan PIP selection form required before issue.";
const CONFIRMED_AT = "2026-10-15T03:12:44.123Z";
const CONFIRMED_SHOWN = "2026-10-15 03:12 UTC";
const RESTRICTED: PipMedical[] = ["opt_out", "250k_excluded", "50k"];

const MI = stateConfig("MI");
const pipLabel = (level: PipMedical) => MI.pipMedical![level].label;
const coverageName = (code: Coverage) => MI.coverages.find((c) => c.code === code)!.name;
const territoryLabel = (t: Territory) => MI.territoryFactors[t].label;

const h = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const money = (n: number) => n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: n % 1 ? 2 : 0 });

interface Seed {
  state?: State;
  city?: string;
  /** undefined = unlimited; null = no election recorded on the row (and none in the rated input). */
  pip?: PipMedical | null;
  confirmedAt?: string | null;
  pkg?: PackageId;
  vehicles?: number;
  payInFull?: boolean;
  /** Store the rating the way rows rated before Michigan have it: no `assessments` on the result. */
  legacy?: boolean;
}

let seq = 0;

/** Writes one applied quote through the real Repo, with a rating produced by the real engine. */
function seed(repo: Repo, o: Seed = {}) {
  const state = o.state ?? "MI";
  const n = ++seq;
  const id = `conv_mi_display_${n}`;
  const isMi = state === "MI";
  const city = isMi ? (o.city ?? "Southfield") : null;
  const territory: Territory = isMi ? territoryForMunicipality("MI", city!).territory : 3;
  const pip = isMi ? (o.pip === undefined ? "unlimited" : o.pip) : null;
  const confirmedAt = o.confirmedAt !== undefined ? o.confirmedAt : pip && RESTRICTED.includes(pip) ? CONFIRMED_AT : null;
  const pkg = o.pkg ?? "recommended";
  const payInFull = o.payInFull ?? false;
  const vehicleCount = o.vehicles ?? 1;

  const input: RatingInput = {
    state,
    territory,
    drivers: [{ age: 41, yearsLicensed: 20, minorViolations3y: 0, majorViolations3y: 0, atFaultAccidents3y: 0 }],
    vehicles: Array.from({ length: vehicleCount }, (_, i) => ({ modelYear: 2020 + i, bodyClass: "sedan" as const, valueBand: "standard" as const, usage: "commute" as const, annualMiles: 12000, antiTheft: false })),
    package: pkg,
    priorInsuranceMonths: 36,
    payInFull,
    effectiveYear: 2026,
    ...(pip ? { pipMedical: pip } : {}),
  };
  const result = rate(input);
  const { assessments: _dropped, ...legacyResult } = result;

  repo.upsertQuoteStart({ id, evalTag: "unit", callerName: "Pat Doe", callerPhone: null, zip: isMi ? "48075" : "08540", state, territory, priorInsuranceMonths: 36, garagingCity: city });
  repo.upsertDriver({ quote_id: id, driver_index: 1, first_name: "Pat", last_name: "Doe", dob: "1985-04-12", license_state: state, license_hash: "h", license_last4: "4321", years_licensed: 20, sr_tickets_3y: 0, sr_at_fault_3y: 0, sr_dui_3y: 0 });
  for (let i = 0; i < vehicleCount; i++) {
    repo.upsertVehicle({ quote_id: id, vehicle_index: i + 1, vin: null, vin_verified: 0, year: 2020 + i, make: "Toyota", model: "Camry", body_class: "sedan", usage: "commute", rideshare: 0, annual_miles: 12000, anti_theft: 0 });
  }
  repo.setCoverage(id, pkg, payInFull, null, pip ? { level: pip, confirmedAt } : null);
  repo.saveRated(id, {
    status: "quoted",
    quoteHash: `hash_${n}`,
    sixMonthPremium: result.sixMonthPremium,
    monthlyPayment: result.monthlyPayment,
    ratingJson: JSON.stringify({ input, result: o.legacy ? legacyResult : result }),
    eligibilityJson: JSON.stringify("OK"),
  });
  repo.createApplication({ app_number: `ANA-${1000000 + n}`, quote_id: id, quote_hash: `hash_${n}`, six_month_premium: result.sixMonthPremium, email: null, applicant_name: "Pat Doe" });
  return { id, input, result, territory };
}

const summary = (repo: Repo, id: string) =>
  renderSummary({ app: repo.applicationByQuote(id)!, quote: repo.getQuote(id)!, drivers: repo.drivers(id), vehicles: repo.vehicles(id), reports: repo.reports(id) });
const opsQuote = (repo: Repo, id: string, conversation?: Conversation) => renderOpsQuote(repo, id, { conversation })!;
const freshRepo = () => new Repo(openDb(":memory:"));

describe("Michigan on the quote summary page", () => {
  test("opt-out quote: city, territory, PIP election, proof note, PPI and LPD rows, MCCA line", () => {
    const repo = freshRepo();
    const { id, result, territory } = seed(repo, { city: "Southfield", pip: "opt_out" });
    const html = summary(repo, id);

    expect(html).toContain("Southfield");
    expect(html).toContain(h(territoryLabel(territory)));
    expect(html).toContain(h(pipLabel("opt_out")));
    expect(html).toContain(CONFIRMED_SHOWN);
    expect(html).toContain(PROOF_NOTE);
    expect(html).toContain(FORM_NOTE);
    expect(html).toContain(`<td>${h(coverageName("PPI"))}</td>`);
    expect(html).toContain(`<td>${h(coverageName("LPD"))}</td>`);

    const mcca = result.assessments[0]!;
    expect(mcca.perVehicle).toBe(9.5); // $19 per car-year, half for a six-month term
    expect(html).toContain(h(mcca.name));
    expect(html).toContain("$9.50 × 1 vehicle = $9.50");
    expect(html).toContain("included in the six-month price");
  });

  test("the PIP row shows the election instead of the literal 'elected'", () => {
    const repo = freshRepo();
    const { id } = seed(repo, { pip: "500k" });
    const html = summary(repo, id);
    const limit = html.match(/<tr><td>Personal injury protection<\/td><td>(.*?)<\/td>/)?.[1];
    expect(limit).toBe(h(pipLabel("500k")));
    expect(html).not.toContain(">elected<");
  });

  test("totals with cents keep their cents; the assessment sits on its own line before the total", () => {
    const repo = freshRepo();
    const { id, result } = seed(repo, { pip: "opt_out" });
    expect(result.sixMonthPremium % 1).toBe(0.5);
    const html = summary(repo, id);
    expect(html).toContain(money(result.sixMonthPremium));
    expect(html).toMatch(/\$[\d,]+\.50/);
    const breakdown = html.slice(html.indexOf("Price breakdown"));
    expect(breakdown).toContain(money(result.policyFee));
    expect(breakdown.indexOf(h(result.assessments[0]!.name))).toBeLessThan(breakdown.indexOf('<tr class="total">'));
    expect(breakdown).toContain(money(result.sixMonthPremium));
  });

  test("the breakdown foots: coverage premiums, adjustments, fee and assessments add up to the total", () => {
    const repo = freshRepo();
    const { id, result } = seed(repo, { pip: "unlimited", vehicles: 2, payInFull: true });
    const html = summary(repo, id);
    const cells = [...html.slice(html.indexOf("Price breakdown")).matchAll(/<td class="r">(-?)\$([\d,.]+)<\/td>/g)].map((m) => (m[1] ? -1 : 1) * Number(m[2]!.replaceAll(",", "")));
    const total = cells.at(-1)!;
    expect(total).toBe(result.sixMonthPremium);
    expect(Math.round(cells.slice(0, -1).reduce((a, b) => a + b, 0) * 100) / 100).toBe(total);
  });

  test("two cars with unlimited PIP: $42 per car, no proof note, no confirmation line", () => {
    const repo = freshRepo();
    const { id } = seed(repo, { pip: "unlimited", vehicles: 2 });
    const html = summary(repo, id);
    expect(html).toContain("$42 × 2 vehicles = $84");
    expect(html).toContain(h(pipLabel("unlimited")));
    expect(html).toContain(FORM_NOTE);
    expect(html).not.toContain("Proof of qualifying coverage");
    expect(html).not.toContain("Eligibility and disclosure confirmed");
  });

  test.each(RESTRICTED)("restricted PIP level %s shows its label, confirmation time and both notes", (level) => {
    const repo = freshRepo();
    const { id } = seed(repo, { pip: level });
    const html = summary(repo, id);
    expect(html).toContain(h(pipLabel(level)));
    expect(html).toContain(CONFIRMED_SHOWN);
    expect(html).toContain(PROOF_NOTE);
    expect(html).toContain(FORM_NOTE);
  });

  test("a restricted level with no recorded confirmation says so instead of inventing a time", () => {
    const repo = freshRepo();
    const { id } = seed(repo, { pip: "opt_out", confirmedAt: null });
    expect(summary(repo, id)).toContain("time not recorded");
  });

  test("state minimum: PIP shows the election, PPI is present, mini-tort (LPD) is not in the package", () => {
    const repo = freshRepo();
    const { id } = seed(repo, { pkg: "minimum", pip: "250k" });
    const html = summary(repo, id);
    expect(html).toContain(`<td>${h(coverageName("PPI"))}</td>`);
    expect(html).not.toContain(h(coverageName("LPD")));
    expect(html).toContain(h(pipLabel("250k")));
    expect(html).not.toContain(">elected<");
  });

  test("shows the state's lawsuit note", () => {
    const repo = freshRepo();
    const { id } = seed(repo);
    expect(MI.lawsuitNote).not.toBe("");
    expect(summary(repo, id)).toContain(h(MI.lawsuitNote));
  });

  test("a Michigan row with no recorded election is priced and shown as the unlimited default", () => {
    const repo = freshRepo();
    const { id } = seed(repo, { pip: null });
    const html = summary(repo, id);
    expect(html).toContain(`${h(pipLabel("unlimited"))} (default, no election recorded)`);
    expect(html).not.toContain(">elected<");
  });

  test("a stored election outside the config is shown as stored, escaped", () => {
    const repo = freshRepo();
    const { id } = seed(repo);
    repo.db.query("UPDATE quotes SET pip_medical = ? WHERE id = ?").run("<b>odd</b>", id);
    const html = summary(repo, id);
    expect(html).toContain("&lt;b&gt;odd&lt;/b&gt;");
    expect(html).not.toContain("<b>odd</b>");
  });

  test("rating stored before Michigan existed (no assessments) renders without a breakdown", () => {
    const repo = freshRepo();
    const { id } = seed(repo, { pip: "unlimited", legacy: true });
    const html = summary(repo, id);
    expect(html).toContain("Southfield");
    expect(html).not.toContain("Catastrophic");
    expect(html).not.toContain("Price breakdown");
  });

  test("the garaging city is HTML-escaped", () => {
    const repo = freshRepo();
    const { id } = seed(repo, { city: `Bad<script>alert(1)</script> & "O'Brien"` });
    const html = summary(repo, id);
    expect(html).toContain("Bad&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;O&#39;Brien&quot;");
    expect(html).not.toContain("<script>");
  });
});

describe("New Jersey summary is unchanged by the Michigan additions", () => {
  test("no MCCA line, no Michigan section, no PIP selection form note", () => {
    const repo = freshRepo();
    const { id, result } = seed(repo, { state: "NJ" });
    expect(result.assessments).toEqual([]);
    const html = summary(repo, id);
    expect(html).toContain("New Jersey");
    expect(html).toContain("Personal injury protection");
    expect(html).toContain("250,000");
    expect(html).toContain(h(stateConfig("NJ").lawsuitNote));
    expect(html).not.toContain("Catastrophic");
    expect(html).not.toContain("Price breakdown");
    expect(html).not.toContain("Michigan");
    expect(html).not.toContain("selection form");
  });

  test("a New Jersey rating stored without assessments renders fine", () => {
    const repo = freshRepo();
    const { id } = seed(repo, { state: "NJ", legacy: true });
    expect(summary(repo, id)).not.toContain("Catastrophic");
  });
});

describe("Michigan on the ops quote page", () => {
  test("opt-out quote: city, territory label, election, notes, lawsuit note, assessment before the total", () => {
    const repo = freshRepo();
    const { id, result, territory } = seed(repo, { city: "Southfield", pip: "opt_out" });
    const html = opsQuote(repo, id);

    expect(html).toContain("garaged in Southfield");
    expect(html).toContain(`territory ${territory} (${h(territoryLabel(territory))})`);
    expect(html).toContain(h(pipLabel("opt_out")));
    expect(html).toContain(CONFIRMED_SHOWN);
    expect(html).toContain(PROOF_NOTE);
    expect(html).toContain(FORM_NOTE);
    expect(html).toContain(h(MI.lawsuitNote));

    const mcca = result.assessments[0]!;
    const worksheet = html.slice(html.indexOf("Rating worksheet"));
    expect(worksheet).toContain(h(mcca.name));
    expect(worksheet).toContain("$9.50 × 1 vehicle = $9.50");
    expect(worksheet).toContain("included in the six-month price");
    expect(worksheet.indexOf(h(mcca.name))).toBeLessThan(worksheet.indexOf(`<b>${money(result.sixMonthPremium)}</b>`));
    expect(worksheet).toContain("<td>PPI</td>");
    expect(worksheet).toContain("<td>LPD</td>");
  });

  test("totals with cents keep their cents (whole-dollar rounding hid them before)", () => {
    const repo = freshRepo();
    const { id, result } = seed(repo, { pip: "opt_out" });
    expect(opsQuote(repo, id)).toContain(`<b>${money(result.sixMonthPremium)}</b>`);
    expect(opsQuote(repo, id)).toContain(`${money(result.sixMonthPremium)} / 6 mo`);
    expect(money(result.sixMonthPremium)).toMatch(/\.50$/);
  });

  test("standard election: no proof note and no confirmation time, form note still shown", () => {
    const repo = freshRepo();
    const { id } = seed(repo, { pip: "250k", vehicles: 2 });
    const html = opsQuote(repo, id);
    expect(html).toContain(h(pipLabel("250k")));
    expect(html).toContain(FORM_NOTE);
    expect(html).not.toContain("Proof of qualifying coverage");
    expect(html).not.toContain("eligibility and disclosure confirmed");
    expect(html).toContain("$9.50 × 2 vehicles = $19");
  });

  test.each(RESTRICTED)("restricted PIP level %s shows its label, confirmation time and notes", (level) => {
    const repo = freshRepo();
    const { id } = seed(repo, { pip: level });
    const html = opsQuote(repo, id);
    expect(html).toContain(h(pipLabel(level)));
    expect(html).toContain(CONFIRMED_SHOWN);
    expect(html).toContain(PROOF_NOTE);
    expect(html).toContain(FORM_NOTE);
  });

  test("a restricted level with no recorded confirmation is flagged", () => {
    const repo = freshRepo();
    const { id } = seed(repo, { pip: "opt_out", confirmedAt: null });
    expect(opsQuote(repo, id)).toContain("time not recorded");
  });

  test("an in-progress Michigan quote (city saved, nothing chosen or rated yet) says PIP is not chosen", () => {
    const repo = freshRepo();
    repo.upsertQuoteStart({ id: "conv_mi_open", evalTag: "unit", callerName: "Pat Doe", callerPhone: null, zip: "48075", state: "MI", territory: 2, priorInsuranceMonths: 36, garagingCity: "Southfield" });
    const html = opsQuote(repo, "conv_mi_open");
    expect(html).toContain("garaged in Southfield");
    expect(html).toContain("not chosen yet");
    expect(html).toContain(FORM_NOTE);
  });

  test("a legacy rating without assessments renders the worksheet with no assessment line", () => {
    const repo = freshRepo();
    const { id } = seed(repo, { pip: "unlimited", legacy: true });
    const html = opsQuote(repo, id);
    expect(html).toContain("Rating worksheet");
    expect(html).not.toContain("Catastrophic");
  });

  test("the garaging city is HTML-escaped", () => {
    const repo = freshRepo();
    const { id } = seed(repo, { city: `Bad<script>alert(1)</script> & "O'Brien"` });
    const html = opsQuote(repo, id);
    expect(html).toContain("Bad&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;O&#39;Brien&quot;");
    expect(html).not.toContain("<script>");
  });

  test("New Jersey: no Michigan lines, no assessment, the state's lawsuit note in the header", () => {
    const repo = freshRepo();
    const { id } = seed(repo, { state: "NJ" });
    const html = opsQuote(repo, id);
    expect(html).toContain("NJ ZIP 08540 · territory 3");
    expect(html).toContain(h(stateConfig("NJ").lawsuitNote));
    expect(html).not.toContain("Catastrophic");
    expect(html).not.toContain("garaged in");
    expect(html).not.toContain("selection form");
  });

  test("the index lists the Michigan garaging city and keeps cents in the premium", () => {
    const repo = freshRepo();
    const mi = seed(repo, { city: "Southfield", pip: "opt_out" });
    const nj = seed(repo, { state: "NJ" });
    const html = renderOpsIndex(repo, { tag: "unit" });
    expect(html).toContain("MI Southfield");
    expect(html).toContain(money(mi.result.sixMonthPremium));
    expect(html).toContain("NJ 08540");
    expect(html).toContain(money(nj.result.sixMonthPremium));
  });
});

describe("agent name in the ops transcript", () => {
  const convo = (role: "agent" | "user"): Conversation => ({ status: "done", durationSecs: 5, hasAudio: false, turns: [{ role, message: "Hello there", secs: 1, tools: [], results: [] }] });

  test("labels agent turns with the configured persona and caller turns with Caller", () => {
    const repo = freshRepo();
    const { id } = seed(repo);
    expect(opsQuote(repo, id, convo("agent"))).toContain(`${h(AGENT_PERSONA_NAME)} · 0:01`);
    expect(opsQuote(repo, id, convo("user"))).toContain("Caller · 0:01");
  });

  // The persona is read from the environment when src/brand.ts loads, so a different name needs a fresh process.
  test("follows AGENT_PERSONA_NAME instead of a hardcoded name, escaped", () => {
    const root = join(import.meta.dir, "..");
    const script = `
      import { openDb, Repo } from ${JSON.stringify(join(root, "src/db/index.ts"))};
      import { renderOpsQuote } from ${JSON.stringify(join(root, "src/server/ops.ts"))};
      const repo = new Repo(openDb(":memory:"));
      repo.ensureQuote("conv_persona", "unit");
      const conversation = { status: "done", durationSecs: 5, hasAudio: false, turns: [{ role: "agent", message: "Hello", secs: 1, tools: [], results: [] }] };
      const html = renderOpsQuote(repo, "conv_persona", { conversation });
      console.log(html.includes("Zed &amp; Co · 0:01") && !html.includes("Lily") ? "OK" : "WRONG");
    `;
    const proc = Bun.spawnSync([process.execPath, "-e", script], { cwd: root, env: { ...process.env, AGENT_PERSONA_NAME: "Zed & Co" } });
    expect(proc.stdout.toString().trim()).toBe("OK");
  });
});
