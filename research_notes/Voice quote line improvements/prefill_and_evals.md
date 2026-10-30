# Prefill/third-party data and eval/monitoring practices for an AI phone auto-insurance quoting line (NJ, PA, MI)

## VIN decoding: NHTSA vPIC and commercial decoders

### Takeaway
vPIC is free, keyless and about 99% reliable for model year 1995 and later. It is a good fit for a demo, but NHTSA publishes no hard rate limit and the batch cap is unstated. It returns vehicle attributes, not insurance rating symbols; those (ISO/Verisk-style) need a commercial source that I could not verify.

### Cited Findings
- vPIC has no daily action limit, needs no registration or API key, and handles about 1,000-2,000 transactions per minute on weekdays without hitting an upper limit. Large batch jobs should run overnight (Eastern) or on weekends. — [NHTSA vPIC FAQ](https://vpic.nhtsa.dot.gov/api/home/index/faq)
- Batch decode takes VINs separated by ";", with an optional "model year," prefix per VIN. There is an unstated upper limit on batch size, and NHTSA recommends looping the standard decode API for large volumes. — [NHTSA vPIC FAQ](https://vpic.nhtsa.dot.gov/api/home/index/faq)
- Decode reliability is about 99% for model year 1995 and later for most major brands, roughly 60-65% for 1980-1994, and pre-1980 vehicles are not covered. Data depends on manufacturer registration. — [NHTSA vPIC FAQ](https://vpic.nhtsa.dot.gov/api/home/index/faq)
- The vPIC About page says quotas and rate limits exist, which conflicts with the FAQ's "no limit" wording. — [About vPIC](https://vpic.nhtsa.dot.gov/About) (as summarized in search results; page not fetched)
- A third-party catalog claims batch mode caps at 50 VINs per call. This is not confirmed against NHTSA docs. A PyPI SDK page cites 100-200 requests per minute, also unconfirmed by NHTSA. — [Jentic catalog](https://jentic.com/apis/nhtsa.dot.gov/nhtsa), [PyPI nhtsa](https://pypi.org/project/nhtsa/)
- Third-party sources say vPIC returns 100+ fields (make, model, year, body style, engine, fuel, drive, plant, safety equipment). One vendor reports average response above 2.5 seconds (anecdotal). — [Apify NHTSA wrapper](https://apify.com/pink_comic/nhtsa-vin-decoder-vehicle-specs-api)
- Paid wrappers of NHTSA data on Apify run about $0.50-$2.50 per 1,000 lookups. Vincario sells subscriptions with monthly lookup caps and 20 free test lookups. — [Apify](https://apify.com/accountable_eel/nhtsa-vin-decoder), [Vincario](https://vincario.com/blog/?p=698)
- S&P Global says VIN decoding is central to insurance pricing and segmentation, and that build-level detail matters more than base-model data. — [S&P Global Mobility](https://www.spglobal.com/automotive-insights/en/blogs/2025/07/decoding-vin-numbers-what-insurers-need-to-know)

### Inferences
- For a phone line, a caller reading a 17-character VIN is the worst slot to capture by voice. Year/make/model plus a vPIC lookup, or VIN read-back verified against vPIC, is more robust. Use the check digit to catch ASR errors before any lookup.
- vPIC fits the demo: free, no key. Cache results and keep a fallback to the existing simulated data on timeout, given the anecdotal 2.5s latency.

### Gaps
- No source found on mapping year/make/model to a VIN prefix or ISO rating symbols, nor on DataOne, Polk/S&P, or Verisk VIN pricing. Needs a targeted follow-up.
- No official vPIC field list or confirmed batch cap was retrieved.

## Insurance prefill products (LexisNexis, Verisk, TransUnion, Carpe Data)

### Takeaway
Prefill products are vendor-claimed to cut quote time from 20+ minutes to under 5 and data entry by 70%+, but I found no independent conversion-lift study. Access is enterprise-only (contracts, FCRA/permissible-purpose onboarding); a small builder cannot self-serve these.

### Cited Findings
- LexisNexis markets Auto Data Prefill as returning verified driver, vehicle and policy data and reducing auto quote time "from over 20 minutes to less than 5 minutes." This is a vendor claim. — [LexisNexis brochure](https://risk.lexisnexis.com/-/media/files/insurance/brochure/auto_data_prefill%20pdf.pdf)
- A Dig-In article on one insurer's project reports data entry for auto quotes down more than 70% and quote time of just over three minutes. — [Dig-In](https://www.dig-in.com/news/simplifying-the-quoting-process-with-auto-prefill)
- Bolt (D2C distribution platform) said only a small percentage of D2C auto quotes convert and expects prefill to raise quote-to-completion. This is an expectation, not a measured result. — [Bolt / LexisNexis](https://www.boltinc.com/news/bolt-and-lexisnexis-partnership-complete-direct-to-consumer-insurance)
- LexisNexis Current Carrier (commercial auto version documented) is a consumer reporting agency product usable only in compliance with FCRA; it provides prior coverage, undisclosed vehicles, additional drivers and lapses. — [LexisNexis Current Carrier sheet](https://risk.lexisnexis.com/-/media/files/insurance/sub%20industry%20page%20assets/commercial/product/current%20carrier%20auto%20for%20commercial/lexisnexis_current_carrier_auto_ss.pdf)
- LexisNexis Carrier Discovery looks up private passenger auto policy data by name+address or VIN, is positioned as non-FCRA, and may not be used for insurance eligibility decisions. — [Carrier Discovery](https://risk.lexisnexis.com/products/carrier-discovery)
- Verisk's prefill product (commercial vehicle) takes name and address and fills 60+ data fields. — [Verisk](https://www.verisk.com/products/commercial-vehicle-prefill/)
- TransUnion launched an Auto Prefill in South Africa (VIN, make, model, year from a single inquiry) claiming higher conversion and fewer abandoned quotes. Not a US product. — [TransUnion](https://newsroom.transunion.co.za/transunions-auto-prefill-solution-enables-quick-accurate-quotes-to-drive-profitability-and-growth/)
- LexisNexis lists Auto Data Prefill for Guidewire InsuranceNow, suggesting integration is through carrier platforms. — [Guidewire Marketplace](https://marketplace.guidewire.com/product/lexisnexis-auto-data-prefill-for-insurancenow/01t3n00000GfLJhAAN)

### Inferences
- Phone+name+address is the typical key set; the largest question savings come from vehicles, household drivers and prior carrier/lapse, which are the same fields your simulated MVR/CLUE/prior-insurance already stand in for. The prefill step is what makes "confirm, don't ask" scripting possible.
- Any real use would require being a licensed insurer/agency with FCRA permissible purpose. For the demo, keep simulation and label it clearly.

### Gaps
- Could not verify what a phone number alone returns, per-call pricing, minimum contracts, or any independent accuracy/conversion data.
- Nothing found on Carpe Data's auto prefill offering, or on Verisk personal auto prefill and ISO ClaimSearch. NJ/PA/MI-specific prefill coverage not found.

## Address verification and ZIP-to-territory

### Takeaway
Smarty offers a free 42-day, 1,000-lookup trial and cheap paid tiers, enough for a demo. ZIP-based territory is common but not universal; garaging address, not mailing ZIP, drives territory, and NJ has proposed municipal-boundary rules.

### Cited Findings
- Smarty trial: $0, 42 days, 1,000 address lookups, no card. Paid tier prices conflict across sources ($50/month on one page, $552/year archived, $25/month for 10,000 lookups on a third-party page). — [Smarty pricing](https://www.smarty.com/pricing/us-address-verification), [Capterra](https://www.capterra.com/p/10014524/Smarty/)
- Insurers price partly on garaging location and many use ZIP codes for territories. Connecticut bans splitting towns into multiple territories, so one insurer used geocoded address data. — [Precisely case study](https://www.precisely.com/resource-center/customer-story/us-insurer-automates-vehicle-territorial-ratings-for-regulation-compliance/)
- In North Carolina, territory follows the ZIP of principal garaging, and if mailing ZIP differs, the garaging ZIP is used. — [NCRB circular A-15-3](https://webha.ncrb.org/Portals/0/ncrb/circular%20letters/automobile/2015/A-15-3%20-%20Revised%20Private%20Passenger%20Auto%20Territory%20Definitions.pdf)
- NJ bill S270 (2026-2027) is a successor to a died 2018 bill that would place exposures by municipal boundary rather than ZIP when ZIPs cross towns; it was referred to committee. — [LegiScan NJ S270](https://legiscan.com/NJ/text/S270/2026)

### Inferences
- The agent should ask "where is the car kept overnight" and standardize that address (not billing), and flag ZIPs that span municipalities or counties, since NJ town and PA municipality lines matter for territory.

### Gaps
- No source quantifying ZIP vs geocode rating error. Smarty CASS certification and MI/PA territory definitions not verified. Whether the Smarty trial restricts API use in production was not checked.

## Telematics / usage-based insurance at quote time

### Takeaway
There is no published controlled evidence on conversion lift from offering telematics at quote time. Indirect data show high opt-in when offered (about 49%) but low exposure and low overall engagement.

### Cited Findings
- Arity (a telematics vendor) says traditional telematics program engagement is under 10% and that waiting for trips before quoting slows onboarding, motivating quote-time pricing. — [Arity](https://arity.com/?p=1282)
- A 2021 TransUnion survey found 49% of consumers opted in when offered, but only about a third had been presented with an offer. — [Carrier Management](https://www.carriermanagement.com/news/2023/01/24/244653.htm)
- An Intact executive (Canada, 2021) put UBI take-up at about 40-50% of new business, with mid-teens share of policies in force. — [Canadian Underwriter](https://canadianunderwriter.ca/news/auto/drivers-are-more-aware-of-usage-based-insurance-but-take-up-remains-sluggish)
- TransUnion reported over 40% of participants saw rates go up, a retention risk. — [Carrier Management](https://www.carriermanagement.com/news/2023/01/24/244653.htm)

### Inferences
- A voice line can cheaply offer a "smartphone-based discount" as a post-quote upsell, but it is a lower priority than prefill and evals. NJ, PA and MI regulatory treatment of telematics was not researched.

### Gaps
- No A/B conversion data; no US state-specific rules; vendor pricing (Arity, Cambridge Mobile Telematics) not found.

## Evaluating voice agents (simulation, tau-style, pass^k, vendors)

### Takeaway
Your tau-style text evals are the right backbone, but tau-Voice shows voice performance drops sharply versus text, so add an audio-layer test tier (noise, accents, interruptions). Vendor platforms cover this but are mostly vendor-authored claims; ElevenLabs' built-in tests are the lowest-friction option for your stack.

### Cited Findings
- tau-Voice extends tau2-bench to full-duplex voice with realistic audio. GPT-5 reasoning scores 80% on text, versus 29-42% for voice agents in clean conditions and 19-30% with noise and diverse accents. It reports pass@1; pass^k use in tau-Voice is unconfirmed. — [arXiv 2603.13686](https://arxiv.org/pdf/2603.13686), [ICML 2026 poster](https://icml.cc/virtual/2026/poster/66590)
- The tau2-bench repo (now "tau3-bench") includes end-to-end voice eval with realtime providers, and notes a July 2026 grading update that makes older banking_knowledge scores incomparable. — [sierra-research/tau2-bench](https://github.com/sierra-research/tau2-bench)
- Hamming claims text-only evaluation misses about 40% of voice-specific failures (vendor claim, relayed by a competitor), and claims 1,000+ concurrent simulated calls. Bluejay claims "500+ real-world simulation variables"; Cekura covers pre-production plus production monitoring; Coval runs synthetic callers and publishes an open STT benchmark. — [Future AGI comparison](https://futureagi.com/blogs/voice-ai-simulation-cekura-hamming-bluejay-coval-2025), [HackerNoon](https://hackernoon.com/best-voice-agent-evaluation-and-testing-tools-in-2026)
- ElevenLabs Tests run simulated conversations for tool calls, human transfers, workflows and guardrails, with deterministic checks on tool parameters, tests generated from past conversations, and CI/CD use. — [ElevenLabs blog](https://elevenlabs.io/blog/tests-for-elevenlabs-agents)
- LangWatch Scenario provides an LLM-judge test harness for ElevenLabs voice agents in CI, using OpenAI for the judge and the simulator's TTS. — [Scenario docs](https://scenario-docs.langwatch.ai/voice/happy-path-elevenlabs)

### Inferences
- Since your rating is deterministic, assert on tool-call arguments (state, DOB, vehicle, coverage) and final quote numbers, and use an LLM judge only for tone, compliance phrasing and hand-off wording.
- Raise k above 2 for the critical flows (pass^5 or higher) and add perturbation variants: ASR noise on names/VINs/DOBs, accents, barge-in, corrections mid-flow. A tau-Voice-style gap is likely on your line too; measure it.

### Gaps
- Vapi test suites: no information retrieved. No independent head-to-head comparison of Hamming/Coval/Cekura/Bluejay. Pricing for all vendors not found.

## Production metrics and alerting

### Takeaway
Hamming's published thresholds are a usable starting scorecard, but they are internally inconsistent and vendor-sourced. Alert on percentiles and task completion, not averages.

### Cited Findings
- Scorecard targets: task completion >85% (warning <75%, critical <70%), WER <8% (warning >12%, critical >15%), intent accuracy >95%, containment >70% (critical <50%), E2E latency P95 <800ms (warning >1200ms). The guide itself also gives <1000ms elsewhere. — [Hamming KPI guide](https://hamming.ai/blog/voice-agent-monitoring-kpis-production-guide)
- Retry rate target <5%, warning >15%; user interruptions target <10%, alert >20%; abandonment target <8%, alert >15%. — [Hamming KPI guide](https://hamming.ai/blog/voice-agent-monitoring-kpis-production-guide)
- Suggested first four alerts: TTFW P90 >1000ms for 5 min, task completion <80% for 15 min, intent accuracy <90% for 10 min, WER >12% for 10 min; 30-minute cooldown; severity tiers P0-P3 with response times of 5 min to 4 hours. — [Hamming KPI guide](https://hamming.ai/blog/voice-agent-monitoring-kpis-production-guide)
- Other Hamming pages set latency percentiles P50 <1.5s, P90 <2.5s, P95 <3.5s, P99 <8s, with industry median P50 1.5-1.7s. A 500ms average can hide 10% of calls above 3s. — [Hamming evaluation guide](https://hamming.ai/blog/how-to-evaluate-voice-agents-2026)
- High containment with low CSAT is "false containment." No numeric sentiment threshold or dead-air benchmark is given (silence gaps >2s are flagged as breaking flow on one page). — [Hamming KPI guide](https://hamming.ai/blog/voice-agent-monitoring-kpis-production-guide)

### Inferences
- For a quoting line, "containment" should be redefined: quote completed, application number issued, or intentional hand-off to a human. Track slot-level re-ask rate for DOB, VIN, address and name spell-back, plus transfer reasons.
- Your hourly canary covers availability; add per-call metrics (TTFW p50/p90, tool latency, re-asks) and alert on rolling-window percentiles.

### Gaps
- No independent (non-vendor) benchmarks; WER-on-slots specifics (entity-level accuracy) not found.

## Conversation analytics on real calls (auto-tagging, QA scoring)

### Takeaway
Little retrieved beyond vendor positioning; the practice is post-call LLM scoring plus failure-mode tagging feeding regression tests.

### Cited Findings
- ElevenLabs supports generating tests from past customer conversations. — [ElevenLabs blog](https://elevenlabs.io/blog/tests-for-elevenlabs-agents)
- Hamming publishes a post-call analytics guide for voice agents (not fetched). — [Hamming post-call analytics](https://hamming.ai/blog/post-call-analytics-voice-agents-metrics-monitoring)
- Cekura reportedly monitors live success rate, hallucination rate, latency, transfers and task completion, and re-runs simulations on prompt or model changes. — [Future AGI comparison](https://futureagi.com/blogs/voice-ai-simulation-cekura-hamming-bluejay-coval-2025)

### Inferences
- A cheap in-house version: nightly LLM pass over transcripts tagging failure modes (mishear, loop, wrong tool args, compliance slip, premature hand-off), with each failed real call converted into a new eval task.

### Gaps
- No sourced numbers on tagging accuracy, QA-score agreement with humans, or sampling rates.

## Access summary for a small demo builder

- Free/self-serve: NHTSA vPIC (no key); Smarty trial (1,000 lookups, 42 days) and cheap tiers; ElevenLabs Tests; open-source tau2-bench voice; LangWatch Scenario.
- Self-serve with cost, details unverified: Coval, Cekura, Hamming, Bluejay (pricing not found); commercial VIN decoders like Vincario.
- Enterprise-only: LexisNexis Auto Data Prefill, Current Carrier, C.L.U.E. Auto; Verisk prefill and ISO products; TransUnion and Carpe Data (FCRA permissible purpose, contracts).
