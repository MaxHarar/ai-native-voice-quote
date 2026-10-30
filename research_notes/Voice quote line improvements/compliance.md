# Compliance map: AI phone agent quoting personal auto insurance (NJ, PA, MI) with post-call SMS summary

Research notes, as of 2026-10-15. This is research, not legal advice; counsel review is flagged per section. Source quality caveat: many sources are law-firm or vendor blogs and advocacy guides; statute text itself was mostly NOT fetched. Items resting only on secondary sources are marked.

## 1. Call recording consent (NJ, PA, MI) and disclosure wording/timing

### Takeaway
Treat the line as an all-party-consent line in all three states. PA is statutorily all-party (18 Pa.C.S. 5703/5704(4)); NJ is one-party (with all-party bills pending); MI's statute reads all-party on its face but appellate courts treat participants as non-eavesdroppers and the issue is unsettled. A plain-language "this call is recorded" notice at the very start, before any personal data, plus continued participation, is the standard way to establish consent (PA case law: knew or should have known).

### Cited Findings
- PA: recording a telephone/electronic communication requires consent of all participants, regardless of privacy expectation (18 Pa.C.S. 5703, 5704(4)) — [RCFP PA guide](https://www.rcfp.org/reporters-recording-guide/pennsylvania/)
- PA: courts find consent where parties knew or reasonably should have known of recording, citing Commonwealth v. Byrd (Pa. 2020) (235 A.3d 311) — [RCFP PA guide](https://www.rcfp.org/reporters-recording-guide/pennsylvania/); secondary cite [Duquesne Juris](https://sites.law.duq.edu/juris/?p=12675)
- PA: one secondary source says 5704(4) prescribes no statutory script or announce-and-continue safe harbor; business-extension summaries conflict (some say one-party plus notice, which is inconsistent with all-party). Treat as unverified — [Ezel PA summary](https://ezel.ai/surveys/call-conversation-recording-consent-requirements/pennsylvania); [recordinglaw.com PA](https://www.recordinglaw.com/party-two-party-consent-states/pennsylvania-recording-laws/)
- NJ: one party's consent suffices to record a phone/electronic communication unless done for a criminal/tortious purpose (N.J.S.A. 2A:156A-3, -4(d)) — [RCFP NJ guide](https://www.rcfp.org/reporters-recording-guide/new-jersey/); [DMLP NJ](https://www.dmlp.org/node/1298)
- NJ: bills A1211 / S1508 (2026-27 session) reportedly would require all-party consent; status unconfirmed (reported in committee) — [Ezel NJ summary](https://ezel.ai/surveys/call-conversation-recording-consent-requirements/new-jersey)
- MI: MCL 750.539c defines eavesdropping as recording private discourse "without the permission of all persons engaged"; felony plus civil remedies — [DMLP MI](https://www.dmlp.org/node/1297); [RCFP MI](https://www.rcfp.org/reporters-recording-guide/michigan/)
- MI: Sullivan v. Gray (1982) and Bloom v. Pegasus (2002) hold a participant is not an eavesdropper; a federal district court disagreed; the MI Supreme Court has not resolved it; RCFP says phone calls may not be recorded without all-party consent — [Barnes & Thornburg alert](https://uatupgrade.btlaw.com/insights/alerts/2020/michigan-supreme-court-to-clarify-interpretation-of-michigans-eavesdropping-statute); [Butzel](https://www.butzel.com/alert-the-u-s-sixth-circuit-court-of-appeals-affirms); [RCFP MI](https://www.rcfp.org/reporters-recording-guide/michigan/)

### Inferences
- Because the line cannot know caller state until after answering (and callers may be traveling), disclose first, on every call, in every state. Suggested script (not statutory text): "Hi, this is Lily, an AI assistant for [Brand]. This call is recorded and transcribed to prepare your quote. If you'd rather not be recorded, say so now and I'll connect you with a licensed specialist." Play before any PII is collected; log the disclosure timestamp and the caller's continued participation as consent evidence.
- Offer a real decline path (human handoff or unrecorded route). This is the strongest answer to the MI ambiguity and PA's "prior consent" requirement. Counsel should confirm whether silence/continuing is sufficient in PA for an AI-vendor third-party recording (ElevenLabs/Twilio also store audio; the provider is arguably a further interceptor).
- Calls to Max's cell for hand-offs (conference transfer) need the recording notice to carry through to the human leg; the specialist should re-state recording status.

### Gaps
- Did not fetch the 18 Pa.C.S. 5704 or MCL 750.539c text; no authoritative confirmation of a PA business-extension exception's conditions.
- Current status of NJ A1211/S1508 and any MI Supreme Court action after 2021 not verified.
- Counsel review needed: PA implied-consent adequacy; whether voice-AI vendor recording is separate interception.

## 2. AI disclosure laws, FCC AI-voice ruling, NAIC Model Bulletin

### Takeaway
FCC (Feb 2024) treats AI-generated voices as "artificial" under the TCPA, which matters for outbound calls/texts, not for pure inbound answering. No NJ/PA/MI chatbot-disclosure statute was found in my searches (gap, not proof of absence); other states (Maine, Utah, etc.) have them and the FTC deception baseline applies. All three states adopted the NAIC AI Model Bulletin, which puts governance, testing, and documentation duties on insurers (and indirectly on their vendors).

### Cited Findings
- FCC Declaratory Ruling, Feb 8, 2024 (unanimous): AI-generated/cloned voices are "artificial or prerecorded voice" under the TCPA; consent rules apply to outbound calls; not a ban — [Hunton](https://huntonak.com/privacy-and-information-security-law/fcc-issues-declaratory-ruling-that-tcpa-applies-to-ai-generated-voice-calls); [Wiley](https://wiley.law/alert-FCC-Extends-Regulatory-Reach-Over-AI-Announces-TCPA-Restrictions-Cover-AI-Generated-Voices-in-Outbound-Calls); [Orrick](https://infobytes.orrick.com/2024-02-16/fcc-ruling-determines-ai-calls-are-subject-tcpa-regulations/)
- Maine: chatbots may not mislead a reasonable consumer into thinking they are human in trade and commerce without clear notice; effective Sept 24, 2025 — [DLA Piper, Jan 2026](https://www.dlapiper.com/insights/publications/2026/01/ai-disclosure-laws-on-chatbots-are-on-the-rise-key-takeaways-for-companies); [MultiState](https://www.multistate.ai/updates/vol-85-state-ai-chatbot-regulation-laws)
- Utah: AI disclosure on request, proactive in regulated contexts (sources disagree on breadth) — [Vaquill guide](https://www.vaquill.ai/blog/ai-chatbot-and-ai-disclosure-laws-by-state); [SiteGPT](https://sitegpt.ai/blog/ai-chatbot-compliance-guide)
- California SB 243 (eff. Jan 1, 2026) covers companion chatbots; one guide says customer-service bots are excluded (vendor source, verify) — [Entagl](https://www.entagl.com/blog/us-ai-chatbot-disclosure-laws-2026)
- NAIC AI Model Bulletin adopted by all three: MI Bulletin 2024-20-INS (Aug 7, 2024); PA Insurance Notice 2024-04 (54 Pa.B. 1910, Apr 6, 2024); NJ DOBI Bulletin 25-03 (Feb 11, 2025). NAIC adoption map status as of May 1, 2026 lists them — [Locke Lord (MI)](https://lockelord.com/newsandevents/publications/2024/08/michigan-issued-bulletin-202420ins-re-use-of-ais-i); [Quarles](https://quarles.com/newsroom/publications/nearly-half-of-states-have-now-adopted-naic-model-bulletin-on-insurers-use-of-ai); [NAIC adoption map](https://content.naic.org/sites/default/files/legal-adoption-map-ai-model-bulletin.pdf); [Anderson Kill (NJ)](https://andersonkill.com/wp-content/uploads/2023/Publications/New-Jersey-Adopts-NAIC-Protocol-for-Use-of-AI-in-Insurance_-AK-NJ-Alert.pdf)
- Bulletin content (summary): written AIS program, governance, risk management, third-party vendor oversight, testing for unfair discrimination, documentation available to regulators on exam — [Kennedys](https://kennedyslaw.com/en/thought-leadership/article/2025/understanding-the-naic-model-ai-bulletin-what-it-means-for-insurers) (secondary; I did not fetch the bulletin text)

### Inferences
- Bulletins bind licensed insurers; a demo line operated by a non-insurer is not directly regulated, but a carrier partner will require vendor diligence artifacts. Build them now: AI system inventory, model/prompt change log, eval results (existing pass^2 evals fit), bias testing of rating inputs, incident log, vendor list (ElevenLabs, Twilio, Railway).
- Disclose AI identity in the opening line regardless: low cost, satisfies Maine/Utah-style rules for callers from those states, and FTC deception risk. The existing "AI-Native Auto Insurance" branding already signals AI; make it explicit.
- TCPA AI ruling is relevant if the line ever places outbound calls (e.g., callbacks) or sends AI-voiced voicemail.

### Gaps
- No NJ, PA or MI enacted AI-disclosure statute found; pending 2025-26 bills in those states not searched specifically. Counsel/tracker check needed.
- Did not read the NAIC bulletin or the three state bulletins directly.

## 3. Producer licensing: can an unlicensed AI quote vs "solicit/negotiate"

### Takeaway
All three states bar selling, soliciting, or negotiating insurance without a producer license. "Solicit" includes attempting to sell or urging someone to apply for a particular kind of insurance from a particular insurer; "negotiate" is conferring on substantive terms (MI definition adds a seller condition). A demo that presents rated prices for a specific insurer's product and invites application sits close to the line, so keep the AI as an information/data-collection tool, gate recommendations/binding to a licensed specialist, and have counsel confirm status.

### Cited Findings
- PA: "insurance producer" = person who sells, solicits or negotiates contracts of insurance; "solicit" = attempt to sell insurance or ask/urge a person to apply for a particular kind of insurance from a particular insurance entity — [FindLaw 40 P.S. 310.1](https://codes.findlaw.com/pa/title-40-ps-insurance/pa-st-sect-40-310-1/) (FindLaw may lag official text)
- PA: unlicensed sell/solicit/negotiate or commission receipt prohibited; civil and criminal penalties — [Pa. Bulletin vol 43](https://www.pabulletin.com/secure/data/vol43/43-45/2127.html)
- MI: MCL 500.1201 definitions of solicit and negotiate (negotiate requires the person also sells or obtains insurance for purchasers); MCL 500.1201a prohibits sell/solicit/negotiate without license; 500.1202 exemptions (amended eff. Oct 17, 2025, text not checked) — [MCL 500.1201](https://legislature.mi.gov/documents/mcl/pdf/MCL-500-1201.pdf)
- NJ: N.J.S.A. 17:22A-29 requires license for sell/solicit/negotiate; solicit definition essentially same as MI/PA; implementing rule N.J.A.C. 11:17A — [NJ session law ch. 210 (2001)](https://njlaw.rutgers.edu/collections/njleg/2001/2001-210.pdf)

### Inferences
- Common carrier structure (not sourced; industry practice, verify): AI gathers data and returns an indicative price on behalf of a licensed agency or carrier; any advice on coverage selection, comparison, or application/bind is done by or under a licensed producer; compensation is not tied to the AI's activity. Here the existing design (hand-off to licensed specialist to bind) is the right shape; add scripted guardrails: AI never recommends specific limits, never says "you should buy", and answers coverage-meaning questions only with neutral scripted definitions or hands off.
- Likely best-practice: operate the line under a licensed agency entity (or have a licensed producer of record supervise) with licensing in each of NJ, PA, MI before any real consumer use. Demo status helps only if clearly labeled and no real binding occurs.

### Gaps
- NJ "negotiate" definition and NJ/PA/MI regulator guidance on automated/online quoting not found. DOBI/PID/DIFS bulletins on "lead generators" or "online quoting" not searched. Counsel needed.

## 4. Texting the quote summary after an inbound call (TCPA, 10DLC, CTIA, PII)

### Takeaway
A texted quote summary that the caller asked for is generally treated as informational, but inclusion of any promotion makes it marketing (written consent needed). Capture explicit verbal consent on the call to receive a text at the number, honor STOP, register A2P 10DLC (sole-prop limits are tight) or use verified toll-free, and keep PII out of the SMS.

### Cited Findings
- FCC revocation rule: consent revocable by any reasonable means; opt-outs honored within a reasonable time not exceeding 10 business days. April 2025 order delayed only the "revoke-all" provision; Jan 6, 2026 order pushed revoke-all to Jan 31, 2027 pending rulemaking. Core reasonable-means/10-day reading is the law firms' interpretation — [Kelley Drye](https://www.kelleydrye.com/viewpoints/blogs/ad-law-access/fcc-issues-one-year-limited-waiver-of-new-tcpa-consent-revocation-rule); [Burr & Forman](https://www.burr.com/telephone-consumer-protection-act/the-fcc-delays-effective-date-of-tcpa-revoke-all-rule-until-january-31-2027); [GM Law](https://www.gmlaw.com/news/fcc-extends-waiver-on-revocation-of-consent-rules-delaying-broad-applicability-until-2027-2/); [Nixon Peabody](https://nixonpeabody.com/insights/alerts/2025/04/11/fcc-partially-delays-new-tcpa-consent-revocation-rules)
- FCC one-to-one consent rule for lead generators was vacated by the 11th Circuit, Insurance Marketing Coalition v. FCC (No. 24-10277), Jan 24, 2025; "prior express consent" need not be one-to-one — [MoFo](https://mofo.com/resources/insights/250130-eleventh-circuit-vacates-fcc-s-tcpa-one-to-one-consent-rule); [Kelley Drye](https://www.kelleydrye.com/viewpoints/blogs/ad-law-access/eleventh-circuit-vacates-tcpa-11-consent-rule). Post-vacatur FCC action not checked.
- Twilio A2P 10DLC sole-proprietor limits: 1 campaign per brand, 1 number per campaign, 1 msg/sec; no EIN permitted (EIN holders must use Low Volume Standard); verification requires a real US/Canadian mobile (not VoIP); fees $4 brand, $15 campaign vetting, $2/mo (2022-23 era pages, verify) — [Twilio limitations](https://support.twilio.com/hc/en-us/articles/1260804728069-Current-Limitations-of-A2P-10DLC); [Twilio who can register](https://support.twilio.com/hc/en-us/articles/4402971752347-Who-Can-Currently-Register-for-A2P-10DLC-in-the-United-States); [Twilio blog](https://www.twilio.com/en-us/blog/new-requirements-for-a2p-10dlc-registrations)
- Quiet hours: vendor sources cite TCPA 8am-9pm recipient local time for marketing texts; FL/OK/WA/MD state variants (8am-8pm); NJ conflicting vendor info; MI pending bill (as of 2023) and existing penal-code provision on annoying commercial calls; PA nothing found — [Goodwin mini-TCPA](https://goodwinlaw.com/en/insights/publications/2023/02/02_28-mini-tcpa-laws-you-should-know); [Referrizer](https://support.referrizer.com/en/category/text-campaigns/article/tcpa-quiet-hours-and-state-specific-rules-for-text-campaigns)
- GLBA/state privacy: NJ Data Privacy Act effective Jan 15, 2025, with entity-level GLBA-type exemption (insurance carve-out reportedly narrower) — [Hunton](https://hunton.com/privacy-and-information-security-law/new-jersey-becomes-14th-state-to-enact-a-comprehensive-state-privacy-law); [Akin](https://www.akingump.com/en/insights/alerts/new-jersey-data-protection-act-what-businesses-need-to-know)

### Inferences
- Flow: ask on the call "Can I text a summary to the number you're calling from? Reply STOP anytime to opt out"; get a spoken yes; store consent record (timestamp, number, call ID, wording, recording snippet). Send only to the verified caller number. Include brand, "AI-generated quote, not a binding offer", a link to a secure page, "Reply STOP to opt out, HELP for help". Send promptly in the same session; skip marketing language so the message stays informational.
- STOP: process any reasonable opt-out phrase (stop, cancel, unsubscribe, quit, end, "don't text me"), confirm once, then suppress. Twilio handles default keywords on some number types but app-level suppression is still needed. Do not require STOP be the only method (reasonable-means rule).
- Sole-prop brand caps (1 number, 1 msg/sec) are fine for a demo; Max's EIN status decides eligibility. Toll-free verification is an alternative (Twilio recommends it for non-US; details not retrieved).
- Do not put DOB, SSN, full address, license number, VIN, application number tied to identity, or premium + name combined in the SMS. Prefer a short link to a tokenized, expiring page; SMS is unencrypted. GLBA safeguards apply if the operator is a financial institution/service provider to one (insurers and producers are).
- Send during 8am-8pm recipient local time to satisfy the strictest cited window; queue after-hours sends.

### Gaps
- CTIA Messaging Principles and Best Practices text not retrieved (STOP/HELP keyword specifics, content rules); toll-free verification requirements not retrieved; Twilio info is dated.
- No definitive source on whether an on-request quote text needs written vs oral consent under current FCC rules (informational messages to a number voluntarily provided are generally "prior express consent"; I did not source this); NJ/MI/PA state telemarketing text rules not confirmed. Counsel review.

## 5. Required insurance disclosures when quoting

### Takeaway
Quote must be framed as non-binding/indicative; state-specific election forms (PA tort, MI PIP) must be provided in statutory/approved form, not substituted by verbal choice; use of credit-based scores, CLUE or MVR triggers FCRA notice duties when it results in adverse action (higher price than otherwise).

### Cited Findings
- PA tort options (75 Pa.C.S. 1705): standardized notice of full tort vs limited tort; limited tort requires an affirmative election, default is full tort; signing an application did not cure missing statutory form (Hockenberry); Donnelly v. Bauer: no remedy for deficient form; a 2025 trial court found a defective form made plaintiff full tort (non-binding) — [PA statute](https://www.legis.state.pa.us/WU01/LI/LI/CT/HTM/75/00.017.005.000..HTM); [vLex 1705](https://us.vlex.com/vid/election-of-tort-options-674823161); [TortTalk 2012](https://www.torttalk.com/2012/03/pennsylvania-superior-court-addresses.html); [TortTalk 2025](https://www.torttalk.com/2025/02/trial-court-judge-creates-remedy-for.html)
- MI PIP medical levels: unlimited, $500k, $250k, $50k (Medicaid-limited), plus Medicare opt-out; selection form must be DIFS-approved (insurers may use state form or own filed form); absent effective election, policy deemed unlimited PIP. Northland Radiology v. Allstate (Mich. App. Mar 25, 2026): all statutory conditions needed for effective opt-out; Bronson (2025): form need not be delivered before issuance — [Michigan Auto Law](https://www.michiganautolaw.com/no-fault/no-fault-act/pip-medical-benefits-coverage/); [DIFS agents FAQ](https://www.michigan.gov/en/difs/industry/insurance/faq/ins-agents-faq); [DIFS Bulletin 2025-07-INS](https://www.michigan.gov/difs/-/media/Project/Websites/difs/Bulletins/2025/Bulletin_2025-07-INS.pdf); [Northland opinion](https://www.michbar.org/Portals/0/opinions/appeals/2026/032526/85489.pdf)
- FCRA 15 U.S.C. 1681m: insurer adverse action (denial, cancellation, higher charge, adverse change) based on a consumer report requires notice incl. agency contact and rights to free report/dispute; Safeco v. Burr (2007): initial-purchase notice required only when rate is higher than it would otherwise be; reckless disregard = willful; credit-score surcharge example — [Texas DOI bulletin](https://www.tdi.texas.gov/bulletins/2002/b-0049-2.html); [Cornell Safeco opinion](https://law.cornell.edu/supct/pdf/06-84P.ZO); [Mass. settlement example](https://www.mass.gov/doc/safety-insurance-group-market-conduct-regulatory-settlement-agreement/download)

### Inferences
- PA: the AI should not accept a verbal tort election as final. Quote both full and limited tort prices, state that the binding election occurs on the signed PA tort form delivered/e-signed via the licensed specialist, and default to full tort until then.
- MI: quote on a stated PIP level (e.g., unlimited) and say selection/opt-out requires the DIFS-approved form with qualifying documentation; no PIP-medical waiver by voice.
- Because quote data is simulated (MVR/CLUE/prior), disclose "simulated/estimated reports for demo"; if ever live, deliver FCRA adverse action notice via the licensed insurer/producer (the notice duty is on the user of the report, not the voice vendor), and consider a FCRA permissible-purpose and authorization script before pulling reports.
- NJ basic vs standard policy disclosure and NJ credit-scoring rules, and MI/PA/NJ credit-use restrictions, were not researched (see gaps). Generic non-binding language: "This is an estimate based on information you provided and is not an offer or binding coverage. Final price and terms depend on verification and underwriting."

### Gaps
- NJ Basic policy / standard policy disclosure requirements (N.J.S.A. 39:6A-23 and NJ Dept. guidance) NOT found. Verify and cite.
- State rules on credit-based insurance scoring (NJ, PA, MI) and state-specific adverse action wording not researched. PA tort form signature requirement not found. Whether MVR from a vendor triggers FCRA: unverified (likely yes if via a consumer reporting agency). Counsel review.

## 6. Data retention and privacy for recordings and transcripts

### Takeaway
No statute I found sets a fixed retention period for call recordings; obligations come from wiretap exposure (recordings are sensitive), NJ privacy act applicability thresholds, GLBA-type safeguards, and insurance record-keeping duties of regulated entities. Minimize and time-limit.

### Cited Findings
- NJ Data Privacy Act (eff. Jan 15, 2025) applies at 100,000 NJ consumers (or 25,000 plus sale revenue); has GLBA entity/data exemptions; no nonprofit exemption — [Akin](https://www.akingump.com/en/insights/alerts/new-jersey-data-protection-act-what-businesses-need-to-know); [Hunton](https://hunton.com/privacy-and-information-security-law/new-jersey-becomes-14th-state-to-enact-a-comprehensive-state-privacy-law)
- Wiretap violations carry criminal and civil exposure in all three states (MI felony; NJ civil damages; PA), which raises the cost of retaining recordings with weak consent evidence — [DMLP MI](https://www.dmlp.org/node/1297); [DMLP NJ](https://www.dmlp.org/node/1298); [RCFP PA](https://www.rcfp.org/reporters-recording-guide/pennsylvania/)
- NAIC Bulletin documentation expectations (retain AI governance and testing records for regulator exam) — [Kennedys](https://kennedyslaw.com/en/thought-leadership/article/2025/understanding-the-naic-model-ai-bulletin-what-it-means-for-insurers)

### Inferences
- The project's existing controls (field encryption, nightly encrypted backups, RETENTION_MODE enforce flag) match this need. Recommended: retain audio/transcripts for a short fixed window (e.g., 30-90 days for demo; a licensed carrier would set insurer record-retention, often years, under its own schedule), delete or redact PII (DOB, SSN, card, license) from transcripts, keep consent-evidence metadata longer, honor deletion requests, restrict access to the ops console (Basic auth is thin; add per-user auth/audit log), and ensure vendor DPAs (ElevenLabs, Twilio) cover retention and no-training. Note that Twilio/ElevenLabs hold their own copies.
- PA and MI have no comprehensive consumer privacy law as far as I know (unverified here); GLBA and FTC Act safeguards still apply to a financial-services-adjacent operator.

### Gaps
- Insurance record-retention statutes (NJ, PA, MI) not found; PA/MI privacy law status unverified in this research; GLBA Safeguards/Privacy Rule applicability to a producer-adjacent demo not analyzed; state insurance data-security laws (NJ, MI Insurance Data Security Act, PA Act 2023-?) not searched. Counsel review.
