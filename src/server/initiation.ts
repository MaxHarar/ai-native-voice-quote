import { AGENT_PERSONA_NAME, BRAND_NAME } from "../brand";
import { RECORDING_DISCLOSURE } from "../disclosure";
import type { Initiation } from "../service";

// ElevenLabs calls this at the start of every inbound Twilio call with the caller's number and the
// conversation id. For a caller with an unfinished quote we return a per-call first message and a
// prompt with a short "This call" section; everyone else gets the agent's defaults untouched.
// No custom dynamic variables are ever introduced: phone calls that miss this webhook (or any
// non-phone conversation) must still start normally.

export const RETURNING_FIRST_MESSAGE =
  `Thanks for calling ${BRAND_NAME}, this is ${AGENT_PERSONA_NAME}, a virtual assistant. ` +
  `${RECORDING_DISCLOSURE} ` +
  `I see a quote in progress from this number. Would you like to pick up where you left off, or start a new one?`;

export function returningCallerSection(resumeCode: string): string {
  return `

## This call: returning caller

This caller's phone number has an unfinished quote, and you already asked whether to continue it or start a new one.

- If they want to continue: ask for their date of birth to verify it's them. Then call \`resume_quote\` with resume_code "${resumeCode}" and that date. Never reveal anything about the saved quote before \`resume_quote\` succeeds; caller ID can be faked.
- If it succeeds: follow its \`next_step\`, and keep going with the normal flow from there (the name is still spelled back before submitting).
- If the date doesn't match, ask once more; after that, or if it's locked, say you'll start a fresh quote and begin at step 1.
- If they want a new quote: begin at step 1 as usual and don't mention the saved one again.`;
}

export interface InitiationResponse {
  type: "conversation_initiation_client_data";
  dynamic_variables: Record<string, never>;
  conversation_config_override?: { agent: { first_message: string; prompt: { prompt: string } } };
}

export function initiationResponse(result: Initiation, basePolicy: string): InitiationResponse {
  const base: InitiationResponse = { type: "conversation_initiation_client_data", dynamic_variables: {} };
  if (!result.returning) return base;
  return {
    ...base,
    conversation_config_override: {
      agent: {
        first_message: RETURNING_FIRST_MESSAGE,
        prompt: { prompt: basePolicy + returningCallerSection(result.token) },
      },
    },
  };
}
