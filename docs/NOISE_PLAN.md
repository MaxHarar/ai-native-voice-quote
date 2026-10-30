# Noise and quiet voice plan for the quote line

Date: 2026-10-15. Status: PROPOSED, awaiting the principal's approval. PLAN ONLY. Nothing was changed. Every call to ElevenLabs was a GET. No deploy, no eval, no config write.
Agent: AI-Native Auto Insurance Quote Line (demo). Stack: Twilio number (native import) to ElevenLabs Agents, ASR `scribe_realtime`, LLM `claude-haiku-5-5`, TTS `eleven_v4_turbo`.

## Bottom line

1. The data does not show a noise or quiet voice problem. It shows a short answer problem. In the one call where the caller reported being unheard, two clear one word answers ("One.", "Pleasure.") were spoken at normal or loud level and never reached the transcript. A third ("zero", low confidence) too. The caller repeated each one after an "Are you still there?" prompt.
2. The "Yes. Yes." stall was also not acoustic. The audio shows a normal level "Yes. Yes." right after a digit read-back. The platform stored the text but never finalized the turn, then 9 s of digital silence, then the caller hung up.
3. All 12 phone calls ran with `turn_timeout` 7 s (git: 7 to 10 in commit 32abcd2 at 23:47 ET; retranscribe and soft timeout added in 98de5c3 at 23:40; deploy at 23:54 ET; last call 23:19 ET). Zero phone calls have run under the current settings. The 10 s fix is unverified on live calls.
4. Noise and quiet voice robustness is unmeasured, not proven fine. Every caller in the sample was a quiet test caller, and the recordings are gated to digital silence between utterances, so a noise floor cannot be read from them.
5. There is no agent side denoise, audio isolation, or VAD sensitivity setting. The live GET returns `vad` with exactly one field, `background_voice_detection` (false), whose behavior is undocumented. The only lever that is immune to acoustics is DTMF keypad input, which is supported on Twilio native and is currently off.
6. A noise harness is feasible over the Agent WebSocket (raw base64 PCM audio in, user transcripts and tool calls out). It is the only way to learn noise behavior before real callers find it.

## Measured baseline

Primary script: `scripts/noise-baseline.ts`
Run: `bun scripts/noise-baseline.ts` (read only, GET `/v1/convai/conversations` and `/v1/convai/conversations/{id}`; output `noise-baseline.json` in the same folder; digits are masked in all quoted text).
Supporting exploratory scripts (timelines, levels, local ASR clip checks) were one-off and are not kept; only the baseline script is reproducible.

Sample: 21 conversations for the agent. 12 are phone (`twilio`), 9 are non phone (not analyzed). Phone calls span 10/14 20:31 to 23:19 ET. 4 of 12 had no caller speech (3 died at connect with "Missing required dynamic variables in tools: eval_tag", fixed in commit 04c0bce at 20:40; 1 hung up at 4 s). So 8 calls with speech, 114 caller turns, 124 spoken agent turns.

| Metric (phone calls only) | Count | Rate | Notes |
|---|---|---|---|
| Caller turns | 114 | | 8 calls |
| Empty or "..." caller turns | 6 | 5.3% of caller turns | All 6 in one call (the 9:50 PM caller). Each was followed within 1 s by an agent check in; 4 of 6 check ins were interrupted by the caller starting to answer; 4 real answers followed within 2 to 3 s |
| Very short caller turns (3 or fewer letters/digits) | 18 | 15.8% | 3 calls. 10 are "No.", 3 are "Yes." |
| Very short, excluding yes/no/ok/hi | 5 | 4.4% | "One." x2, a number, "SUV.", "GLC." All legitimate answers, not noise artifacts |
| Agent "Sorry, I missed that" | 0 | 0% of agent turns | |
| Agent "Did I lose you" | 0 | 0% | |
| Agent "still there" | 4 | 3.2% of agent turns | 1 call. Plus 1 "still with me" (extended phrase set) |
| Caller turns without finalized ASR metrics | 2 | 1.8% | 1 real mid call stall ("Yes. Yes."), 1 artifact after the agent had already ended the call |
| Tail stalls (last turn caller, unfinalized, 8 s or more) | 1 | 1 of 8 speech calls | The "Yes. Yes." call |
| Agent turns interrupted by caller | 22 | 17.7% | 13 of them in one chatty call. `ignored_as_backchannel` was 0 everywhere |
| Possible repeated agent turns (word overlap 0.7 or more) | 0 | 0% | |
| Calls reaching `get_quote` / submitting an application | 2 / 0 | | Demo line, many calls were tests |

How calls ended (raw `termination_reason`): 6 "Call ended by remote party", 3 "Call was transferred to number", 3 "Missing required dynamic variables in tools: eval_tag". By outcome: 4 no caller speech, 3 transferred to a human, 4 caller hung up mid flow (56 s, 71 s, 121 s which is the stall, 358 s after hearing the price), 1 agent ended the call after the caller cancelled.
ASR timing is not the problem: caller turn ASR trailing latency p50 34 ms, p90 55 ms. Agent `convai_turn_silence_before_initiation` p50 0.26 s, p90 0.54 s, max 21.1 s (the 21 s case is a 7 s timeout after a long agent turn).
`features_usage.dtmf_input` was `enabled: false` on every call.

Audio findings (recordings via GET `/v1/convai/conversations/{id}/audio`: mono, 16 kHz, 128 kbps MP3, a mix of both sides; analyzed in memory, nothing quoted):

| Finding | Evidence | Confidence |
|---|---|---|
| Recordings are gated: digital silence (about -80 dBFS) between utterances | `noise-audio-levels.ts window` | High. Consequence: no noise floor or SNR can be measured from recordings |
| "Yes. Yes." (23:11 call, 104 s) was audible at normal level, then 9 s of digital silence, then hang up at 121 s | envelope shows caller burst at about -23 dBFS frame level; local whisper clip reads "Yes." | High. Turn detection or finalization failure, not noise |
| Dropped short answer at 165.5 s in the 9:50 PM call: a loud "One." (clip peak -10 dBFS) with no transcript turn; repeated at 173 s after the check in | local whisper.cpp base.en on a 0.7 s clip; transcript has no turn between 159 s and 171 s | Medium to high (one local ASR, hand picked window) |
| Dropped "Pleasure." at 229.0 s (clip peak -11.3 dBFS), repeated at 236 s | same method | Medium to high |
| Probable dropped answer at 144.1 s (whisper heard "zero", clip peak -13.3 dBFS) | same method | Low. Whisper base can mishear; the caller said "More." at 149 s |
| The "..." at 171 s sits in digital silence (caller silent about 7 s, timeout fired). The "..." at 233 s coincides with caller speech onset at the same instant as the agent check in | envelope plus timestamps | Medium |

Method caveats, stated plainly: n is tiny (8 speech calls, one call carries all 6 empty turns and all check ins). The three dropped answers were found by hand around the "..." events, not by a systematic detector, so no dropped answer rate is claimed. The only way to get a rate is the harness (known script, known ground truth). A population statistic on caller loudness was attempted and discarded as contaminated; the only loudness claim is that the hand checked utterances peaked at -10 to -16 dBFS, comparable to agent speech, so none were quiet. Pre fix baseline: all 12 calls ran with a 7 s timeout, no retranscribe, no soft timeout.

Unifying hypothesis (unverified): very short one word answers are the failure class. Some are dropped outright, some are transcribed but never committed ("Yes. Yes." after a digit read back, where `spelling_patience: auto` may be waiting for more digits). Loudness is not the cause. `retranscribe_on_turn_timeout` is the platform's own backstop for this and is already on, but untested live.

## Levers

Live `conversation_config` keys present (GET `/v1/convai/agents/{id}`): `asr`, `turn`, `tts`, `conversation`, `language_presets`, `vad`, `realtime_model`, `agent`. Key name grep for noise, denoise, isolation, threshold, sensitivity, gain, volume found only `conversation.background_sound.volume` (outbound, see table) and `tts.audio_effects` (outbound). Current values: `asr` = quality high, provider `scribe_realtime`, format `pcm_16000`, 8 keywords. `turn` = timeout 10, eagerness normal, spelling_patience auto, speculative_turn true, retranscribe_on_turn_timeout true, turn_model turn_v3, interruption_ignore_terms empty, silence_end_call_timeout -1. `vad` = `{background_voice_detection: false}`. `conversation.dtmf_input_settings` = null. Built in tools configured: `end_call`, `transfer_to_number`. `skip_turn` and `play_keypad_touch_tone` = null.

| Lever | What it does | Evidence | Expected impact | Risk | Effort |
|---|---|---|---|---|---|
| DTMF keypad input (`conversation.dtmf_input_settings`, now null) | Caller types digits; one sequence becomes one user turn; `#` ends it (default on); timeout 2 s (range 0.5 to 10); buffer 0-9, `*`, `#`, A-D, up to 50 chars; first key interrupts the agent; `redact_input` hides digits in stored transcripts | https://elevenlabs.io/docs/eleven-agents/customization/multimodal-input (DTMF section), https://elevenlabs.io/docs/changelog/2026/8/31. Docs warn only out of band DTMF from Twilio, SIP trunking or Genesys works; Twilio native import is supported | High for ZIP, DOB, PA license (8 digits), miles, months insured, application number. Immune to noise and level. Not usable for the NJ license letter or VIN letters | Caller friction (phone off the ear); prompt and tool description changes; digit turns arrive with `source_medium: dtmf`; unverified how this agent's LLM handles it until tested | M |
| `turn_timeout` (now 10, range 1 to 30) | How long the agent waits before re-engaging | https://elevenlabs.io/docs/eleven-agents/customization/conversation-flow#turn-timeout | Medium. At 7 s, 4 of 6 check ins collided with the caller starting to answer | Longer dead air for absent callers | XS (already 10; unverified live) |
| `turn_eagerness` (patient / normal / eager) | How quickly the agent takes its turn. Docs recommend Patient for phone numbers and addresses | https://elevenlabs.io/docs/eleven-agents/customization/conversation-flow#turn-eagerness | Unknown for dropped one word answers (unverified). Mainly helps slow or soft speakers being cut off | Slower feel; per step switching needs workflows | XS to test, L for per step |
| `skip_turn` system tool (null) | LLM stays silent when caller says "give me a second"; no config needed | https://elevenlabs.io/docs/eleven-agents/customization/tools/system-tools/skip-turn | Medium for the wallet / license hunt moments that produced "Are you still there?" | LLM over uses it and goes quiet; mitigated by timeout | XS |
| `spelling_patience` (auto / off) | "Auto = model based, Off = never wait extra" when caller is spelling numbers and entities | https://elevenlabs.io/docs/eleven-agents/api-reference/agents/get (TurnConfig) | Possible fix for the "Yes. Yes." stall (hypothesis from n=1, unverified) | Off may cut callers off mid license number, the reason it is on (deploy.ts comment) | XS to flip, needs harness to judge |
| `retranscribe_on_turn_timeout` (true) | At timeout, re-transcribes accumulated audio if VAD heard nothing; disables silence discount billing | same API reference | Backstop for missed or quiet speech. Already on | Cost | Done |
| `speculative_turn` (true), `turn_model` (v3 vs v2) | Starts LLM generation during silence before the turn is final; selects turn detector version | API reference above; https://elevenlabs.io/docs/changelog/2026/2/2, https://elevenlabs.io/docs/changelog/2026/6/8 | Unknown (unverified). Candidates to A/B for the stall class | Regressions | XS, harness gated |
| `vad.background_voice_detection` (false) | Only field of `vad`. Behavior undocumented. Presumably ignores other voices behind the caller | https://elevenlabs.io/docs/changelog/2026/8/3 states only that it exists, boolean, default false | Unknown (unverified). Could cut false barge ins from TV or crowd | May suppress a soft or speakerphone caller | XS to flip, harness gated |
| `interruption_ignore_terms` / `merge_with_default_ignore_terms` | Words that do not interrupt the agent (case insensitive exact match) | API reference above | Low to medium: fewer noise or backchannel cut offs of read backs (22 of 124 agent turns were interrupted, mostly legitimate) | Could swallow a real short answer (unverified how ignored terms are handled) | XS |
| `asr.keywords` (8 now) | Boosts listed terms | API reference above. Standalone Scribe Realtime keyterms are limited to 50 terms of 20 chars: https://elevenlabs.io/docs/eleven-api/guides/how-to/speech-to-text/batch/keyterm-prompting (agent limits unverified) | Low for noise. Some gain on makes and models | Over boosting | XS |
| `asr.provider` (`scribe_realtime`, `scribe_v2_turbo`, `elevenlabs`) | Selects the ASR | API reference above. Differences undocumented | Unknown (unverified) | Regression | XS to flip, harness gated |
| Input noise suppression, denoise, audio isolation inside Agents | NOT AVAILABLE. No such field in the live GET or the API schema. Voice Isolator is a separate product, not wired to agent input | https://elevenlabs.io/docs/overview/capabilities/voice-isolator. Standalone Scribe Realtime has `filter_background_audio`: https://elevenlabs.io/docs/api-reference/speech-to-text/v-1-speech-to-text-realtime (not exposed on agents) | n/a | n/a | n/a |
| VAD sensitivity or gain control | NOT AVAILABLE on agents (standalone STT has `vad_threshold`, `min_speech_duration_ms`; agents expose neither) | live GET; https://elevenlabs.io/docs/api-reference/speech-to-text/v-1-speech-to-text-realtime | n/a. Worth asking ElevenLabs support | | |
| `background_sound`, `tts.audio_effects` | Outbound only. "The agent does not hear the background sound, and it is not sent into speech recognition" | https://elevenlabs.io/docs/eleven-agents/customization/voice/audio-environment | None for caller noise. Do not use | | |
| `silence_end_call_timeout` (-1) | Ends the call after N s since the caller last spoke | API reference above | Cleans up dead calls like the stall | Ends slow callers | XS |
| Twilio side noise cancellation | None found for PSTN or Media Streams. Twilio noise cancellation (RNNoise or Krisp) is in the Voice JS SDK for browser clients. Media Streams carry raw mu-law 8 kHz mono | https://www.twilio.com/en-us/changelog/twilio-voice-js-sdk-noise-cancellation-reference-components, https://www.twilio.com/docs/voice/media-streams/websocket-messages. Native import auto configures the number: https://elevenlabs.io/docs/eleven-agents/phone-numbers/twilio-integration/native-integration | None. Absence is unverified (no Twilio doc says it does not exist) | | |
| Carrier with built in suppression (Telnyx: Krisp, DeepFilterNet, AiCoustics; `direction` semantics are inverted) | Server side suppression on calls to AI | https://developers.telnyx.com/docs/voice/programmable-voice/noise-suppression; ElevenLabs SIP: https://elevenlabs.io/docs/eleven-agents/phone-numbers/sip-trunking | Possibly high for noise. Unverified end to end with ElevenLabs | Number port or forward, new failure modes | L |
| Custom bridge: Twilio Media Streams to RNNoise / Krisp / Voice Isolator stream to Agent WebSocket | Denoise before the agent hears audio | WebSocket docs below | Possibly high for noise | Loses native telephony features (transfer, out of band DTMF paths unverified); added latency | XL, last resort |
| Conversation design (see Phase 2) | Coach after misses, keypad fallback, shorter chunked read backs, skip_turn cues | https://elevenlabs.io/docs/eleven-agents/best-practices/prompting-guide (tool error handling and read back sections) | Medium to high for the observed failures | Longer calls | S to M |
| Experiments (branch traffic split), alerts, data collection | Safe rollout and monitoring. Alerts cover conversation failure, tool failure, webhook error, guardrail, call initiation, evaluation score. No ASR failure monitor | https://elevenlabs.io/docs/eleven-agents/operate/experiments, https://elevenlabs.io/docs/eleven-agents/operate/alerts, https://elevenlabs.io/docs/eleven-agents/customization/agent-analysis/data-collection | Enables safe A/B and drift detection | Traffic is tiny, so A/B has no statistical power | S |

## Recommended plan in phases

Order is as requested: measure, cheap config, conversation design, harness, monitoring. One rule overrides the order: do not flip any undocumented toggle (`vad.background_voice_detection`, `asr.provider`, `spelling_patience`, `speculative_turn`, `turn_model`) on the live agent before the harness can judge it. Stage every change on a cloned test agent or a zero traffic branch (versioning is visible on this agent: `version_id`, `branch_id`; https://elevenlabs.io/docs/eleven-agents/operate/versioning).

### Phase 0: measure under the current config (about half a day of Max's time)
Max places about 20 scripted phone calls on the current deploy: 10 clean, 5 on speakerphone or Bluetooth in a car, 5 deliberately quiet voice or TV and kitchen noise. Scripts contain one word answers and a digit string each. Rerun `noise-baseline.ts`. Add a valid dropped answer audit (gaps in agent audio plus local whisper) or defer to the harness.
Success metric (proposed): at least 100 caller turns; dropped one word answers 2% or less; unfinalized mid call turns 0; "..." turns 1% or less; check ins interrupted by the caller 0.

### Phase 1: cheap config, one change at a time, staged
1. Confirm the 10 s timeout from Phase 0 data.
2. Add `skip_turn` plus one prompt line ("if the caller asks for a moment, call skip_turn").
3. Set `silence_end_call_timeout` to about 45 s with a short message so a stalled call ends itself.
4. Try `turn_eagerness: patient` on the staged agent only.
Success metric (proposed): collisions 0 and no new stalls over 20 calls; mean call length up by 10% or less.

### Phase 2: conversation design and DTMF
1. Enable `dtmf_input_settings` (timeout 2 to 3 s, `#` terminator, `redact_input` true for PII). Offer the keypad for ZIP, DOB, PA license, miles, months insured. Voice stays the default; after two misses on the same field say "you can also type it on your keypad, then press pound".
2. After two consecutive misses: ask the caller to move somewhere quieter or hold the phone closer. After the third: transfer (the policy already hands off when "going in circles after two tries").
3. Chunk read backs (license in groups, confirm each) and end them with an explicit cue ("say yes if that matches"). The "Yes. Yes." stall followed a long digit read back that ended in a bare "Is that right?" (n=1, test in the harness).
4. Update `policy/quote-line-policy.md`, the `save_driver` and `start_quote` tool descriptions (digit strings now arrive as keypad turns), and `test/agent-config.test.ts`.
Success metric (proposed): keypad used on at least half of the offered digit fields; read back correction rate no worse than baseline; no completion drop.

### Phase 3: noise harness (see next section)
First use: reproduce the clean audio short answer drop as the control. Then sweep noise and level. Then judge the staged toggles one at a time.
Success metric (proposed): task success 90% or better at SNR 20 and 10 dB and 80% or better at SNR 5 dB and at -20 dB speech level; adopt a toggle only if task success rises by 5 points or more or re ask rate falls 25% or more with no regression elsewhere.

### Phase 4: monitoring
Scheduled run of `noise-baseline.ts` (daily or weekly) with alert thresholds: "..." turns above 3%, any unfinalized mid call turn, "still there" or "missed that" above 5% of agent turns. Add data collection items (caller had to repeat; agent asked "are you still there") and an evaluation criterion for dead air. Track `features_usage.dtmf_input.used`. Use a 10% branch experiment for any toggle that passes the harness. Recordings expire after 30 days (`privacy.retention_days`), so export any audit sample you want to keep.
Success metric (proposed): dashboard of the Phase 0 metrics with no unexplained week over week regression.

## Verification design (feasibility only, not built)

Verdict: feasible. Evidence:
1. Endpoint `wss://api.elevenlabs.io/v1/convai/conversation?agent_id=...` (signed URL for private agents). Client sends `{"user_audio_chunk": "<base64 audio>"}`. Server first sends `conversation_initiation_metadata` with `user_input_audio_format` and `agent_output_audio_format` (this agent: `pcm_16000` both; enum also allows `ulaw_8000`). So raw simulated callers are supported. https://elevenlabs.io/docs/eleven-agents/libraries/web-sockets, https://elevenlabs.io/docs/eleven-agents/api-reference/eleven-agents/websocket
2. Server events give what the metrics need: `user_transcript`, `agent_response`, `audio`, `interruption`, `ping`/`pong`; `vad_score` (probability the user is speaking) and `tentative_user_transcript` exist but must be listed in the agent's `client_events`; the live agent lists only audio, interruption, agent_response, user_transcript, agent_response_correction, agent_tool_response. So run the harness on a cloned test agent with those events enabled (creating it is a POST, which is out of scope for now). https://elevenlabs.io/docs/eleven-agents/customization/events/client-events
3. Tool calls and parameters come back afterwards from GET `/v1/convai/conversations/{id}` (`transcript[].tool_calls[].params_as_json`, verified in the live data), so task success is checkable against the script.
4. The text simulate API is deprecated and text only, and Agent Testing (Simulation, Next Reply, Tool Call) uses a simulated AI user with no audio, so neither exercises ASR. https://elevenlabs.io/docs/eleven-agents/guides/simulate-conversation, https://elevenlabs.io/docs/eleven-agents/customization/agent-testing

Design:
1. Scripts: 6 to 10 fixed caller scripts covering name, ZIP, months insured, DOB, state, license digits, one word answers (yes, no, one, zero, full, monthly), VIN groups, spell backs.
2. Caller audio: synthesize with ElevenLabs TTS at 16 kHz PCM across several voices and speeds. The TTS API also accepts `audio_effects` with `filter_preset_id` (for example `phone`) and `background_noise_id` (for example `cafe`) from `GET /v1/audio-effects/catalog` (https://elevenlabs.io/docs/changelog/2026/10/12), but that has no SNR control, so mix noise locally.
3. Conditions: clean control; noise mixed at SNR 20, 10, 5 dB (babble, cafe, TV, road; noise files must be sourced, none verified); speech attenuated by 20 dB; combined 10 dB plus -20 dB. Emulate PSTN: downsample to 8 kHz, G.711 mu-law round trip, band limit 300 to 3400 Hz, back to 16 kHz PCM. `ffmpeg` is installed locally. Twilio Media Streams are mu-law 8 kHz mono, https://www.twilio.com/docs/voice/media-streams/websocket-messages.
4. Streaming: real time paced 20 to 100 ms chunks, silence between turns, wait for agent audio end before the next line (or deliberately talk over it).
5. Metrics: task success (tool call parameters equal script values); re ask rate (agent phrase regex plus repeated question overlap, as in `noise-baseline.ts`); ASR word error rate and digit string exact match (`user_transcript` versus script text, normalized); dropped utterance rate (script line with no `user_transcript`); stall rate (no agent response within 8 s of line end); time to first agent audio.
6. Caveats: the WebSocket path is not the Twilio native path (transcoding and endpointing may differ, unverified), so keep a handful of real phone calls as a cross check; runs hit the tool server, so use a tagged test agent and test tool URL or accept test rows; cost is agent minutes plus TTS credits (about 3 to 4 minutes of agent time per scripted call; pricing not checked); use at least 3 repeats per cell because LLM and ASR are stochastic.

## Open questions for the principal

1. Who are the real callers and where are they (cars, kitchens, TV, kids)? That decides whether noise robustness or short answer reliability gets the effort first.
2. Approve a cloned test agent for the harness (a POST) and a credits budget for agent minutes and TTS?
3. Approve turning on DTMF keypad input, and for which fields? It changes the call flow and adds friction.
4. Will Max place the roughly 20 scripted phone calls for Phase 0?
5. OK to open an ElevenLabs support question on: what `vad.background_voice_detection` does, why single word answers are dropped, whether VAD sensitivity or gain can be tuned, and how `scribe_v2_turbo` differs from `scribe_realtime`?
6. Is a latency increase from `patient` eagerness acceptable?
7. Is a carrier move (Telnyx) or a custom denoise bridge on the table, or is that out of scope for a demo line?
8. Call recordings contain names, birth dates and license digits. I analyzed them in memory and with an offline local whisper model on tiny clips (temp files deleted). Is that acceptable going forward, and should an audit sample be exported before the 30 day retention expires?

## Compliance notes

Only GET requests were sent to ElevenLabs (conversations list and detail, conversation audio, agent config) and to public docs. No secret was printed. One throwaway `python3` sanity command that only printed "python ok" was run by mistake; no Python script was written or used.
