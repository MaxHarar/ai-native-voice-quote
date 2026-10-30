# Conversation design, turn-taking, data-capture accuracy and latency for AI phone agents

Scope note: most sources found are vendor docs and blogs (2025-2026). I found no independent, peer-reviewed benchmark of ASR on 8 kHz spelled letters/digits, and no controlled study tying question count to abandonment on AI phone agents. Those are flagged as gaps.

## Turn-taking, endpointing, short answers, barge-in

### Takeaway
ElevenLabs documents `turn_eagerness: patient` as the intended setting for collecting phone numbers, addresses and emails, and recommends 10-15 s timeout plus patient eagerness for "information collection". Competing platforms rely on number-aware endpointing (Vapi), model-based end-of-turn (Deepgram Flux, LiveKit) and eager/speculative LLM start to cut dead air. Short one-word answers are mainly a risk when endpointing is too eager or ASR finalizes late. Noise-triggered false barge-ins are the main counter-risk of tuning toward responsiveness.

### Cited Findings
- ElevenLabs `turn_timeout` range is 1-30 s; docs recommend 5-10 s for casual conversations and 10-30 s when users need time to formulate responses. — [ElevenLabs conversation flow](https://elevenlabs.io/docs/eleven-agents/customization/conversation-flow.md)
- ElevenLabs `turn_eagerness` has values patient / normal / eager. Eager is "best for customer service"; Patient is "best for collecting phone numbers, addresses, or email addresses". — [ElevenLabs conversation flow](https://elevenlabs.io/docs/eleven-agents/customization/conversation-flow.md)
- ElevenLabs recommended config table: Information collection = turn timeout 10-15 s, interruptions enabled, eagerness Patient. Customer service = 5-10 s, Eager. Legal disclaimers = interruptions disabled. — [ElevenLabs conversation flow](https://elevenlabs.io/docs/eleven-agents/customization/conversation-flow.md)
- ElevenLabs "soft timeout" filler: `soft_timeout_config.timeout_seconds` default -1 (disabled), range 0.5-8 s, recommended 3.0 s; default message "Hhmmmm...yeah."; fires once per turn only when the LLM response is slower than the timeout; optional LLM-generated message; docs say avoid time indicators like "One second..." in filler. — [ElevenLabs conversation flow](https://elevenlabs.io/docs/eleven-agents/customization/conversation-flow.md)
- Disagreement on turn_timeout default: API reference search summary says 7 s; the conversation-flow page does not state a default. Docs vs SDK type names for eagerness also differ (eager/normal/patient vs high/standard/low). Verify against the live agent config. — [ElevenLabs conversation flow](https://elevenlabs.io/docs/eleven-agents/customization/conversation-flow); [SDK TurnConfig types](https://whatsapp.kawanelite.com/node_modules/%40elevenlabs/elevenlabs-js/api/types/TurnConfig.d.ts)
- Vapi heuristic endpointing is number-aware: after a transcript ending in a number it waits 0.5 s by default, after punctuation 0.1 s, with neither 1.5 s. waitSeconds default reported as 0.4 s (support forum, lower reliability). Smart endpointing is English only. — [Vapi voice pipeline configuration](https://docs.vapi.ai/customization/voice-pipeline-configuration); [Vapi support thread](https://support.vapi.ai/t/27151661/improving-latency)
- Deepgram Flux: `eot_threshold` 0.5-0.9 (default 0.7); `eot_timeout_ms` 500-10000 (default 5000) as silence fallback; `eager_eot_threshold` off by default, enabling it yields EagerEndOfTurn/TurnResumed events so LLM work can start early at a cost of roughly 50-70% more LLM calls. — [Deepgram Flux configuration](https://developers.deepgram.com/docs/flux/configuration); [Deepgram Flux quickstart](https://developers.deepgram.com/docs/flux/quickstart.mdx)
- LiveKit: endpointing uses min delay (~0.5 s) and max delay (3 s or 6 s, docs disagree by version); a turn-detector model supplies confidence that picks between them; dynamic endpointing adapts delay from session pause statistics (Python only); adaptive interruption mode exists. — [LiveKit turn handling options](https://docs.livekit.io/reference/agents/turn-handling-options); [LiveKit KB](https://kb.livekit.io/articles/6569137565-how-does-end-of-utterance-detection-work-in-conversations)
- LiveKit forum report: EOT detection can finish after a late STT final, causing the turn to flush early; suggested raising min delay for slow STT. — [LiveKit community](https://community.livekit.io/t/cloud-turn-detector-failed-late-stt-final-warnings-after-enabling-livekit-inference-audio-turn-detection-vad/1472)
- Barge-in: callers from cars and weak cellular links generate higher VAD false-trigger rates; generic VAD tuned on clean audio fails on real telephony; levers are VAD thresholds, minimum speech duration before confirming barge-in, and disabling interruption during required disclosures. — [Decagon barge-in glossary](https://decagon.ai/glossary/what-is-voice-agent-barge-in); [Ringg barge-in](https://www.ringg.ai/glossary/barge-in); [Dograh barge handling](https://www.dograh.com/feeds/blog/barge-handling)

### Inferences
- Our config (turn_v3, timeout 10 s) already matches ElevenLabs' "information collection" recommendation on timeout; confirm `turn_eagerness` is `patient` (or at least `normal`) during digit/name/email slots, and consider per-slot behavior via prompt (e.g. agent says "go ahead, take your time" before long strings).
- Dropped short answers ("yes", "no", "two") most plausibly come from the turn ending or the ASR finalizing before the word is committed. Our `retranscribe_on_turn_timeout` already addresses part of this; a patient eagerness setting for yes/no confirmation slots trades about a few hundred ms for fewer dropped answers. Not measured; test with real calls.
- Soft timeout (about 3 s) is a cheap dead-air fix for slow tool calls (rating, MVR/CLUE lookups) if not already enabled. Avoid "one moment" style filler per ElevenLabs guidance.

### Gaps
- No quantitative study of how often short one-word answers are dropped under each platform's endpointing settings; only configuration guidance found.
- Retell and OpenAI Realtime (server_vad / semantic_vad) and Twilio ConversationRelay endpointing specifics were not researched in depth.
- Did not find ElevenLabs documentation of turn_v3 internals.

## Capturing names, spellings, digit strings, VINs, emails

### Takeaway
General-purpose ASR is markedly worse on identifiers than on ordinary speech: one academic corpus showed 96.6% word accuracy but only 77% exact-match identifiers. Best practice from the sources is read-back confirmation digit by digit, constrained validation (pattern/checksum), custom vocabulary or keyterms, and keypad or text fallback when confidence is low.

### Cited Findings
- Sheffield SNuC corpus (via Speechmatics): baseline 96.6% word-level accuracy but only 77% full-identifier exact match; identifier-specific adaptation raised exact match to 91.7%. "Near-97% word accuracy still left almost one in four identifiers wrong." — [Speechmatics](https://speechmatics.com/company/articles-and-news/alphanumeric-speech-recognition-why-voice-assistants-mangle-skus-and-how-to-fix-it)
- Speechmatics vendor-reported sequence accuracy: 98.0% digits, 96.9% spelled letters, 85.4% mixed alphanumerics (dataset undisclosed, not independently verified). Telephone bandwidth makes letters like "XL"/"XS" hard to tell apart; accents drop accuracy about 15%. — [Speechmatics](https://speechmatics.com/company/articles-and-news/alphanumeric-speech-recognition-why-voice-assistants-mangle-skus-and-how-to-fix-it)
- Older telephone benchmark in a US patent (undated, likely old systems): about 98% per-digit accuracy for telephone digits, about 75% per character for alphanumerics. — [USPTO document 6922669](https://image-ppubs.uspto.gov/dirsearch-public/print/downloadPdf/6922669)
- Deepgram cites 43-58% accuracy for commercial ASR on alphanumeric sequences vs 95-99% on general speech, without naming a study (vendor claim, treat as unverified). — [Deepgram alphanumeric benchmark](https://deepgram.com/learn/alphanumeric-pronunciation-tts-quality-benchmark)
- Spoken-form variation hurts: "double nine six" vs "nine nine six", "oh" vs "zero". — [LREC 2022 paper](https://preview.aclanthology.org/fix_video/2022.lrec-1.212.pdf)
- Mitigations from Speechmatics: focused custom vocabulary (about top 1,000 items; very large lists degrade), fuzzy match to known catalog, grammars/pattern checks (an older Microsoft Research study reportedly roughly halved semantic errors with regex-derived grammars), confidence routing (commit confident, escalate uncertain), track exact-match and character error rate rather than WER. — [Speechmatics](https://speechmatics.com/company/articles-and-news/alphanumeric-speech-recognition-why-voice-assistants-mangle-skus-and-how-to-fix-it)
- Read-back advice: read phone numbers digit by digit including area code, re-verify the whole number after any correction (call-center guide; its "20% more errors caught" claim is uncited, do not rely on it). — [Anser phone guide](https://www.anser.com/qa/phones)
- LLM read-back hazards: a Retell thread traced a consistently wrong first digit to an example number in the system prompt; fix was an explicit "say each digit exactly as it appears" instruction. A Vapi thread reports transcriber adding digits the caller never said. TTS often speaks digit strings as whole integers unless told to speak digits. — [Retell community](https://community.retellai.com/t/ai-agent-reads-back-incorrect-first-digit-of-phone-number-continued/2474); [Vapi support](https://support.vapi.ai/t/23110400/caller-phone-number-confirmation-issue); [Genesys community](https://community.genesys.com/discussion/voice-bot-read-each-digit-instead-of-whole-number)
- ElevenLabs Scribe v2 Realtime advertises about 150 ms latency, supports mu-law/PCM and the Twilio ConversationRelay integration; no documentation found on keyterm behavior in the realtime variant or on telephony alphanumeric accuracy. — [ElevenLabs realtime STT](https://elevenlabs.io/realtime-speech-to-text); [Bolna docs](https://www.bolna.ai/docs/providers/transcriber/elevenlabs)

### Inferences
- Plan for roughly 1 in 4 raw identifier captures being wrong without mitigation (SNuC baseline; different domain, so directional). Our deterministic validators (Luhn application number, VIN checksum, state license formats, DOB sanity) are the strongest lever in the sources: pattern constraints plus read-back.
- Chunked read-back (3-3-4 for phones, 4-4-... for VIN) is common practice, but sources here recommend digit by digit with pauses; chunk with explicit pauses and confirm each chunk to localize errors. No source measured chunked vs unchunked.
- Names: spell-back with NATO words ("D as in Delta") is standard practice but I found no measured benefit in these sources.
- Email by voice is the highest-risk slot; offering SMS/text-link capture or having the agent confirm via spell-back is warranted. No source quantified email error rate.

### Gaps
- No published error rate for 8 kHz PSTN spelled letters/digits on modern ASR (Scribe, Deepgram Nova/Flux, Whisper). The arXiv paper 2506.05400 (second-stage error detection for phone-conversation information extraction) looked relevant but its PDF could not be parsed; its figures are not reported here.
- No measured comparison of NATO-alphabet prompting vs plain letter spelling.
- No source quantified chunked vs unchunked read-back.

## DTMF in AI voice agents

### Takeaway
The prevailing pattern is speech for conversation and keypad for sensitive or hard numeric input, mainly as a fallback for noise, accents or compliance. Implementation risk is in signaling: needs out-of-band (RFC 4733) or reliable in-band detection and an agent state machine that reacts to keypresses.

### Cited Findings
- Keypad input recommended as a fallback in noisy environments, with heavy accents, speech impairments, and for sensitive identifiers; regulated sectors (banking, telehealth) often require DTMF-only entry for sensitive identifiers (vendor glossaries; claim not checked against regulation). — [Cognigy DTMF](https://www.cognigy.com/glossary/what-is-dtmf); [Decagon DTMF](https://decagon.ai/glossary/what-is-dual-tone-multi-frequency-dtmf); [Dograh DTMF](https://www.dograh.com/feeds/blog/dtmf-detection-voice-agent)
- Failure mode: caller presses a key but the agent never advances state and the caller hangs up; platform should support RFC 4733 out-of-band DTMF. — [Dograh DTMF](https://www.dograh.com/feeds/blog/dtmf-detection-voice-agent)
- ElevenLabs `play_keypad_touch_tone` system tool is outbound only (agent presses keys to navigate other IVRs), supports 0-9, *, #, pause codes w/W, works with Twilio and SIP trunk. Inbound DTMF collection appears to be a separate feature; one translated doc page says an out-of-band RFC 4733 option applies to SIP trunks and is ignored for Twilio native calls. Exact inbound DTMF tool/schema not confirmed. — [ElevenLabs play keypad touch tone](https://elevenlabs.io/docs/eleven-agents/customization/tools/system-tools/play-keypad-touch-tone); [ElevenLabs zh docs](https://elevenlabs.io/docs/zh/eleven-agents/customization/tools/system-tools/play-keypad-touch-tone)
- Vapi's endpointing treats a transcript ending in a number as a special case (0.5 s wait), reflecting that digit strings need extra silence tolerance. — [Vapi voice pipeline configuration](https://docs.vapi.ai/customization/voice-pipeline-configuration)

### Inferences
- With Twilio native import, in-band tone detection quality is unknown; verify with a live test before relying on DTMF for ZIP/DOB fallback. Low-risk first use: a single-key control ("press 1 to repeat", "press pound when done") or DTMF only after two failed speech attempts on a slot.
- Friction trade-off: DTMF breaks hands-free/car callers, so keep it as an offered fallback, not default.

### Gaps
- No adoption statistics or measured completion/accuracy comparison of DTMF vs speech for AI agents.
- ElevenLabs inbound DTMF configuration for Twilio native not confirmed.

## Latency targets and techniques

### Takeaway
Practitioner target is under about 800 ms voice-to-voice with best systems at 400-600 ms; human gaps are about 200 ms. The 800 ms figure is a rule of thumb, not a formal standard.

### Cited Findings
- Natural-feeling threshold about 800 ms voice-to-voice; above about 1.5 s feels broken; top systems 400-600 ms; model-based endpointing fires in 200-400 ms vs 800 ms+ for naive silence thresholds (vendor blogs; no primary research found for the 800 ms number). — [Twig latency budgets](https://www.twig.so/blog/voice-ai-agents-latency-budget-800ms); [Telnyx comparison](https://telnyx.com/resources/voice-ai-agents-compared-latency)
- Retell lab test (competitor-authored, no sample sizes): Retell 620 ms end-to-end, PolyAI 780, Dialogflow CX 920, Twilio Voice 1,040; targets TTFT under 300 ms, end-to-end under 800 ms, barge-in under 200 ms. — [Retell latency face-off](https://www.retellai.com/da/resources/ai-voice-agent-latency-face-off-2025)
- LiveKit forum: end-of-turn wait can account for about 30% of end-to-end latency. — [LiveKit community](https://community.livekit.io/t/eot-value-leads-to-around-30-of-e2e-latency-tried-reducing-min-max-endpointint-in-turn-delay-plugin-but-no-luck/1450)
- Techniques named: stream every stage, tool calls in parallel with inference, model-based endpointing, speculative/eager LLM start (Deepgram Flux eager EOT, +50-70% LLM calls), filler on slow turns (ElevenLabs soft timeout). — [Twig](https://www.twig.so/blog/voice-ai-agents-latency-budget-800ms); [Deepgram Flux quickstart](https://developers.deepgram.com/docs/flux/quickstart.mdx); [ElevenLabs conversation flow](https://elevenlabs.io/docs/eleven-agents/customization/conversation-flow.md)

### Inferences
- With Haiku as LLM and Scribe realtime (about 150 ms), the dominant latency terms are likely turn-end wait and webhook tool calls on Railway; patient eagerness adds wait precisely on slots where accuracy matters more than speed. Spend latency budget on endpointing where accuracy matters, cut it on tool calls (parallelize, cache lookups, keep tool responses small).

### Gaps
- No ElevenLabs-specific measured voice-to-voice latency over Twilio.
- Speculative generation is not documented for ElevenLabs Agents in the sources found.

## Flow design, slot filling, abandonment, expectation setting

### Takeaway
Little hard evidence exists for AI quoting agents. The only quantified phone-flow data found is from an IVR survey study; practitioner guidance says keep calls short, front-load key questions and set expectations.

### Cited Findings
- 15-question IVR survey study (Ethiopia, health care, 2025): 92.6% answered the call, 65.6% answered at least one question, 42.9% completed all; full survey took about 8.1 min. — [JMIR Formative Research 2025](https://formative.jmir.org/2025/1/e67452)
- Practitioner guidance: keep IVR surveys under about five minutes; completion drops as length grows but no hard threshold; put important questions first; use short scales answerable by keypad. — [Crazy Egg](https://crazyegg.com/blog/ivr-survey); [TechRepublic](https://www.techrepublic.com/article/ivr-survey/)

### Inferences
- A quote call that collects many identity and vehicle fields resembles a long survey; front-load the fields that enable a partial quote, state the expected duration up front, and let returning callers skip fields (already built via DOB-verified codes).
- Structured slot-filling with LLM flexibility (accept multiple slots in one utterance, confirm in batches) is common practice but I found no measured comparison.

### Gaps
- No source measured abandonment vs question count for AI voice agents, nor the effect of "this takes about 5 minutes" expectation-setting.
- Google CCAI / Dialogflow CX / Amazon Lex design guides and Cathy Pearl's book were not retrieved.

## Noisy environments, speakerphone, car callers

### Takeaway
Car and speakerphone callers cause false barge-ins and ASR hallucinations; fixes are noise suppression before VAD, echo cancellation, minimum speech duration before confirming barge-in, and confirmation or DTMF for risky slots.

### Cited Findings
- Callers from cars generate higher false-trigger rates and may need environment-aware thresholds; speakerphone needs acoustic echo cancellation so the agent's voice is not re-heard. — [Decagon](https://decagon.ai/glossary/what-is-voice-agent-barge-in); [Ringg](https://www.ringg.ai/glossary/barge-in)
- Krisp claims background voice cancellation cuts false-positive VAD triggers 3.5x (vendor-reported); noise-triggered VAD events can make STT hallucinate words. — [AssemblyAI](https://www.assemblyai.com/blog/noise-cancellation-stt-pros-cons)
- Sensitive barge-in detection truncates prompts on line noise; conservative detection feels deaf; modes include hotword-only and windowed (no interruptions during required disclosures). — [Dograh barge handling](https://www.dograh.com/feeds/blog/barge-handling)

### Inferences
- Disable interruption during the recording/consent disclosure and quote read-out, enable it elsewhere; add a prompt rule to repeat or confirm when a transcript looks like noise or a fragment.

### Gaps
- No measured false-interruption rates for ElevenLabs on car/speakerphone calls.
- Whether Twilio native import offers noise suppression was not checked.
