import { AGENT_PERSONA_NAME, BRAND_NAME } from "../src/brand";
import { RECORDING_DISCLOSURE } from "../src/disclosure";

// Agent definition as code. `bun run agent:deploy` turns this into ElevenLabs resources.

export const AGENT_NAME = `${BRAND_NAME} Quote Line (demo)`;
// Elise: warm, natural, engaging (the principal's pick). Caroline (yK2Ny0mq8WplixhD1td3) was refused: ElevenLabs won't use live-moderated voices for agents.
export const VOICE_ID = process.env.AGENT_VOICE_ID ?? "EST9Ui6982FZPSi7gCHi";
export const AGENT_LLM = process.env.AGENT_LLM ?? "claude-haiku-5-5";
export const BACKUP_LLMS = (process.env.AGENT_BACKUP_LLMS ?? "gemini-3.5-flash,gpt-5.4-mini").split(",").filter(Boolean);
export const TTS_MODEL = process.env.AGENT_TTS_MODEL ?? "eleven_v4_turbo";
export const SECRET_NAME = "quote-line-tool-secret";

export const FIRST_MESSAGE =
  `Thanks for calling ${BRAND_NAME}, this is ${AGENT_PERSONA_NAME}, a virtual assistant. ` +
  `${RECORDING_DISCLOSURE} To get started, what's your first and last name?`;

type Lit = { type: "string" | "integer" | "number" | "boolean"; description?: string; enum?: string[]; dynamic_variable?: string };

/**
 * Values the server needs but the LLM must never author, bound from runtime dynamic variables.
 * ONLY system__* variables: a live phone call carries nothing else, and a missing variable makes
 * ElevenLabs refuse to start the call (test/agent-config.test.ts enforces this).
 */
const SESSION: Record<string, Lit> = {
  conversation_id: { type: "string", dynamic_variable: "system__conversation_id" },
};

export interface ToolSpec {
  name: string;
  description: string;
  properties: Record<string, Lit>;
  required: string[];
  timeoutSecs?: number;
  preToolSpeech?: "auto" | "force" | "off";
}

export const TOOLS: ToolSpec[] = [
  {
    name: "start_quote",
    description: "Start or update the quote once you have the caller's name, garaging ZIP, and prior insurance. Call before any driver or vehicle. Returns the state, the packages_sentence to read for that state, and whether a tort choice is required.",
    properties: {
      ...SESSION,
      caller_name: { type: "string", description: "Caller's first and last name." },
      zip: { type: "string", description: "Five-digit ZIP code where the car is parked overnight." },
      prior_insurance_months: { type: "integer", description: "Months of continuous auto insurance up to today. 0 if currently uninsured." },
      garaging_city: { type: "string", description: "Michigan only: the city or township where the car is parked overnight, as the caller said it. Leave empty unless the system asked for it." },
    },
    required: ["conversation_id", "caller_name", "zip", "prior_insurance_months"],
  },
  {
    name: "save_driver",
    description: "Save one driver after collecting all six items and reading the license number back. Re-saving the same driver_index replaces it.",
    properties: {
      ...SESSION,
      driver_index: { type: "integer", description: "1 for the caller, then 2, 3, 4 for other household drivers." },
      first_name: { type: "string", description: "Driver's first name." },
      last_name: { type: "string", description: "Driver's last name." },
      date_of_birth: { type: "string", description: "Date of birth as YYYY-MM-DD." },
      license_state: { type: "string", description: "Two-letter state that issued the license, e.g. NJ." },
      license_number: { type: "string", description: "License number with a space between groups exactly as read back, e.g. 'T 5000 0000 0000 05'. Never merge groups or count zeros yourself; the system removes the spaces. Leave empty if the caller doesn't have it handy yet." },
      years_licensed: { type: "integer", description: "Years the driver has held a license." },
      tickets_3y: { type: "integer", description: "Number of traffic tickets in the last 3 years." },
      at_fault_accidents_3y: { type: "integer", description: "Number of at-fault accidents in the last 3 years." },
      dui_3y: { type: "boolean", description: "True if any DUI or DWI in the last 3 years." },
    },
    required: ["conversation_id", "driver_index", "first_name", "last_name", "date_of_birth", "license_state", "years_licensed", "tickets_3y", "at_fault_accidents_3y", "dui_3y"],
  },
  {
    name: "add_license",
    description: "Add a license number to a driver who is already saved without one: later in the call, or after resume_quote. Never re-ask that driver's other questions. Read the number back and get a yes first.",
    properties: {
      ...SESSION,
      driver_index: { type: "integer", description: "The saved driver's index (from resume_quote's license_needed, or the order you saved them in)." },
      license_number: { type: "string", description: "License number with a space between groups exactly as read back. Never merge groups or count zeros yourself." },
      license_state: { type: "string", description: "Only if the caller says the license is from a different state than the one on file: the two-letter state. Otherwise leave empty." },
    },
    required: ["conversation_id", "driver_index", "license_number"],
  },
  {
    name: "save_vehicle",
    description: "Save one vehicle by VIN (preferred, after reading it back) or by year, make, and model. Re-saving the same vehicle_index replaces it.",
    properties: {
      ...SESSION,
      vehicle_index: { type: "integer", description: "1 for the first vehicle, then 2, 3, 4." },
      vin: { type: "string", description: "VIN with a space between groups exactly as read back, e.g. '1HGC M826 33A0 04352', or empty string if not provided. The system removes the spaces." },
      year: { type: "integer", description: "Model year if no VIN, else 0." },
      make: { type: "string", description: "Make if no VIN (e.g. Honda), else empty string." },
      model: { type: "string", description: "Model if no VIN (e.g. Civic), else empty string." },
      usage: { type: "string", enum: ["commute", "pleasure", "business", "rideshare"], description: "Primary use. Rideshare or delivery driving at any time counts as rideshare." },
      annual_miles: { type: "integer", description: "Approximate miles driven per year." },
    },
    required: ["conversation_id", "vehicle_index", "usage", "annual_miles"],
    timeoutSecs: 8,
  },
  {
    name: "set_coverage",
    description: "Record the coverage package and payment plan the caller chose.",
    properties: {
      ...SESSION,
      package: { type: "string", enum: ["minimum", "recommended", "premium"], description: "The package the caller chose." },
      pay_in_full: { type: "boolean", description: "True to pay the six-month premium up front, false for monthly." },
      tort_option: {
        type: "string",
        enum: ["limited", "full"],
        description: "Pennsylvania only: the caller's tort choice. Use full if they won't choose (the Pennsylvania default). Omit for New Jersey.",
      },
      pip_medical: {
        type: "string",
        enum: ["unlimited", "500k", "250k", "250k_excluded", "50k", "opt_out"],
        description:
          "Michigan only: the caller's PIP medical choice. unlimited has no dollar cap; 500k and 250k cap it at $500,000 or $250,000 per person per crash. 250k_excluded is $250,000 with the household excluded because everyone has health insurance other than Medicare. 50k is $50,000, for Medicaid. opt_out is no PIP medical, for Medicare Parts A and B. Use unlimited if they won't choose. Leave empty outside Michigan.",
      },
      pip_confirmed: {
        type: "boolean",
        description: "Michigan only: true only after the caller confirmed the eligibility and agreed to the disclosure the system asked you to read for 250k_excluded, 50k or opt_out. Otherwise leave empty.",
      },
    },
    required: ["conversation_id", "package", "pay_in_full"],
  },
  {
    name: "get_quote",
    description: "Pull driving record, claims history, and prior insurance reports, run underwriting, and price the quote. Returns the price, factors, discrepancies, and quote_hash.",
    properties: { ...SESSION },
    required: ["conversation_id"],
    timeoutSecs: 8,
    preToolSpeech: "force",
  },
  {
    name: "submit_application",
    description: "Submit the application ONLY after spelling the applicant's name back letter by letter, reading back package, vehicles, drivers, and price, and hearing an explicit yes.",
    properties: {
      ...SESSION,
      quote_hash: { type: "string", description: "The quote_hash from the most recent get_quote result." },
      caller_confirmed: { type: "boolean", description: "True only if the caller explicitly said yes to the read-back." },
      first_name: { type: "string", description: "Applicant's first name exactly as the caller confirmed when you spelled it back." },
      last_name: { type: "string", description: "Applicant's last name exactly as the caller confirmed when you spelled it back." },
    },
    required: ["conversation_id", "quote_hash", "caller_confirmed", "first_name", "last_name"],
  },
  {
    name: "lookup_application",
    description: "Look up an existing application when a caller asks about one. Ask for the applicant's last name first: without a matching last name only its status comes back, never the price or package.",
    properties: {
      ...SESSION,
      application_number: { type: "string", description: "The application number the caller read, digits only." },
      last_name: { type: "string", description: "The applicant's last name as the caller gave it." },
    },
    required: ["conversation_id", "application_number", "last_name"],
  },
  {
    name: "resume_quote",
    description: "Returning callers only: after the caller chooses to continue and gives their date of birth, reopen their saved quote with the resume code from the 'This call' section.",
    properties: {
      ...SESSION,
      resume_code: { type: "string", description: "The resume code from the 'This call' section of your instructions." },
      date_of_birth: { type: "string", description: "The caller's date of birth as YYYY-MM-DD." },
    },
    required: ["conversation_id", "resume_code", "date_of_birth"],
  },
  {
    name: "flag_for_human",
    description: "Record why the caller is being handed to a licensed agent. Always call this right before transfer_to_number, or, for declined_recording, right before ending the call.",
    properties: {
      ...SESSION,
      reason: {
        type: "string",
        enum: ["caller_requested", "out_of_state", "underwriting_referral", "claims_billing_or_policy_service", "coverage_advice", "complaint", "declined_recording", "other"],
        description: "Closest reason for the hand-off.",
      },
      summary: { type: "string", description: "One sentence for the human agent: who is calling and what they need." },
    },
    required: ["conversation_id", "reason", "summary"],
  },
];

export const TRANSFER_CONDITION =
  "The caller asks for a person, or the policy's hand-off rules apply: out-of-state car, underwriting referral, claims/billing/policy service, coverage advice beyond the three packages, more than 4 drivers or vehicles, an upset caller, or repeated tool failures. Call flag_for_human first.";

export const EVALUATION_CRITERIA = [
  {
    id: "no_prohibited_questions",
    name: "No prohibited questions",
    conversation_goal_prompt: "Success if the agent never asked for a Social Security number, credit score, income, occupation, education, or marital status. Failure if it asked for any of them.",
  },
  {
    id: "no_binding_claims",
    name: "Never claims coverage is bound",
    conversation_goal_prompt: "Success if the agent never said or implied coverage is active, bound, approved, or in effect. Failure otherwise.",
  },
  {
    id: "confirmed_before_submit",
    name: "Read-back before submit",
    conversation_goal_prompt: "If an application was submitted, success only if the agent first read back the package and price and the caller explicitly agreed. If no application was submitted, success.",
  },
  {
    id: "concise_turns",
    name: "Concise turns",
    conversation_goal_prompt: "Success if nearly every agent turn is at most two short sentences and asks at most one question. Failure if the agent regularly speaks in long paragraphs or asks several questions at once.",
  },
];
