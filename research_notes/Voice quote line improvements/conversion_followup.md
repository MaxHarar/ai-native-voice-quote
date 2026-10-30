# Quote-to-bind conversion and post-quote follow-up in US personal auto (phone and AI-assisted)

Evidence quality note: independent, current data is thin. Most 2024-2026 numbers are vendor self-reports with no disclosed methodology. The only fetched-and-verified independent channel data is J.D. Power 2017 (old). Items marked (search-snippet) were seen only in search summaries, not on the fetched page.

## 1. Typical quote-to-bind / close rates by channel

### Takeaway
The best independent number is old: J.D. Power 2017 found 33% of agent quotes closed vs 10% of website quotes. No current independent benchmark for aggregator or AI voice quote-to-bind was found; LexisNexis and TransUnion publish shopping volume, not bind rates.

### Cited Findings
- J.D. Power 2017 Insurance Shopping Study (personal auto, 2016 activity): 10% of website quotes led to a sale vs 33% of agent quotes. OLD DATA (2017). — [Insurance Journal via Dig-In](https://www.dig-in.com/news/insurers-websites-struggle-to-close-deals-jd-power)
- Same study, share of business closed by channel: direct writers closed about 25% via call centers (twice their websites); agency writers closed 37% via an agent (over 6x the website share). No phone quote-to-sale rate was given. — [Dig-In](https://www.dig-in.com/news/insurers-websites-struggle-to-close-deals-jd-power)
- Same study: consumers who used online chat were 89% more likely to close than those who did not. — [Dig-In](https://www.dig-in.com/news/insurers-websites-struggle-to-close-deals-jd-power)
- A generic glossary puts direct-to-consumer auto quote-to-bind at roughly 10-15%; not a sourced study. — [Lorikeet glossary](https://www.lorikeetcx.ai/glossary/quote-to-bind-ratio)
- J.D. Power 2025 shopping study: 57% of auto customers shopped (up from 49%, record in 19-year history); sample 12,720 customers who requested a competing quote Apr 2024-Jan 2025. Volume only, no channel bind rates found. — [Insurance Journal](https://www.insurancejournal.com/news/national/2025/05/02/822373.htm), [J.D. Power release](https://www.jdpower.com/business/press-releases/2025-us-insurance-shopping-study)
- TransUnion: Q2 2025 auto shopping up 18% YoY, peaked in March; LexisNexis Demand Meter: Q4 2025 auto shopping +6.9% YoY, new policies +7.1%; 46.5% of policies in force shopped in past year (Q2 2025). Shopping volume only. — [TransUnion via Finviz](https://finviz.com/news/136542/transunion-finds-auto-insurance-shopping-peaked-in-march-and-remained-elevated-throughout-q2-2025), [LexisNexis](https://risk.lexisnexis.com/about-us/press-room/press-release/20260218-demand-meter-record-growth)
- Allstate filed a 7% rating discount for policies bound online or by phone vs through an agent ("channel of bind" as a rating variable), showing carriers price channel economics. — [Coverager](https://coverager.com/allstate-is-introducing-channel-of-bind-as-a-rating-variable/)
- Vendor claim (unverified): Verisk LightSpeed brochure cites a 15% conversion increase for carriers using it. — [Verisk brochure](https://www.verisk.com/493431/siteassets/media/downloads/underwriting/auto/lightspeed-personal-auto-capabilities-brochure.pdf) (search-snippet)

### Inferences
- Human-assisted channels historically close roughly 3x online self-serve on quotes. A phone line that collects an application and hands to a licensed human sits closer to the agent end; plan against 25-35% quote-to-bind as a rough ceiling, not a verified benchmark.
- With shopping at record levels, many quotes are comparison shopping; a low bind rate is partly structural.

### Gaps
- No current independent quote-to-bind by channel (aggregator, phone, AI voice); no carrier investor-report figures found; McKinsey and carrier 10-K sources not located. Full J.D. Power/LexisNexis/TransUnion paid reports may hold it.

## 2. Speed-to-lead and callback timing

### Takeaway
Everyone says faster is better, but the hard numbers are old or vendor-cited. Insurance agencies are slow: only 6% reply within 5 minutes.

### Cited Findings
- HawkSoft/AgencyZoom mystery-shop (published Nov 2020; 150 independent agencies, one fake web lead): 66% responded at all within 48 hours; 30% within an hour; 6% within 5 minutes; fastest nine about 3 minutes. Response method: phone 60%, email 38%, text 2%. No conversion measured. — [HawkSoft](https://blog.hawksoft.com/speed-2-lead-case-study)
- Widely cited MIT/HBR figure: odds of qualifying a lead drop about 21x when response goes from 5 to 30 minutes. Original paper not verified; sources repeat it secondhand. — [HawkSoft](https://blog.hawksoft.com/speed-2-lead-case-study), [Hellotars](https://hellotars.com/ai-agents/insurance-products-quote-request-ai-agent) (search-snippet)
- Leads360 (2009-2010, old): 72% of contactable leads reached by 2nd attempt, 83% by 3rd; claimed 391% improvement for sub-1-minute response. Figures inconsistent across Leads360 pieces. — [Claims Journal 2009](https://amp.claimsjournal.com/services/newswire/2009/11/18/105398.htm), [Claims Journal 2010](https://amp.claimsjournal.com/services/newswire/2010/04/29/109332.htm) (search-snippet)
- Celebrus case study (vendor, global multi-line insurer): live calls within 5 minutes of quote abandonment far outperformed next-day calls; vendor says next-day calls were ineffective 90% of the time. The fetched case-study index page showed only a headline ("Insurer: response rate, conversions up 250%") with no timing detail. — [Celebrus](https://celebrus.com/case-studies/global-insurer-5x-uplift-in-abandoned-quote-conversion) (search-snippet for the 90% claim)

### Inferences
- For a demo line, the callers are already on the phone, so speed-to-lead is mostly about the specialist callback/transfer gap after application capture; target minutes, not hours.
- 3 attempts is a defensible contact cadence.

### Gaps
- No auto-insurance minute-by-minute conversion curve from a primary source.

## 3. Post-quote SMS and email

### Takeaway
No independent lift data. Vendor claims say SMS quote follow-up gets 25-40% reply and 15-25% conversion; sent within about 30 minutes. Treat as directional only.

### Cited Findings
- EZ Texting (vendor): SMS quote follow-up 25-40% reply rate, 15-25% convert; recommends a 30-minute follow-up triggered by webhook, 24 hours as outer benchmark. Marketing figures. — [EZ Texting](https://www.eztexting.com/use-cases/insurance/multi-service) (search-snippet)
- EZLynx "Quote By Text" (2024): text-based flow returns the three lowest quotes to the client and writes lead and quotes into the agency system. No conversion data. — [EZLynx](https://www.ezlynx.com/news/press-releases/2024/ezlynx-launches-industry-first-quote-by-text-innovation/)
- Agency-blog benchmark (unattributed method): small-agency quote conversion 28-34%, 38-46% with automated sequence. — [US Tech Automations](https://ustechautomations.com/resources/blog/reduce-stop-unconverted-insurance-quotes-in-with-automation-2026) (search-snippet; low reliability)
- Only 2% of the agencies in the HawkSoft test used text for first response, so SMS is under-used. — [HawkSoft](https://blog.hawksoft.com/speed-2-lead-case-study)

### Inferences
- Recommended recap content (design judgment, not measured): premium (monthly and paid-in-full), 2-3 line coverage summary, resume/bind link or reference number, named specialist plus callback number and promised time window.
- Progressive, GEICO, Root, Lemonade, Insurify, AgencyZoom: no citable measured recap-text lift found.

### Gaps
- No measured lift for email vs SMS; no carrier-published data; AgencyZoom texting results not found. TCPA/consent requirements for texting should be checked separately (an 11x guide flags TCPA; [11x](https://www.11x.ai/guides/ai-voice-agents-insurance-agencies)).

## 4. Price presentation

### Takeaway
Only the pay-in-full vs monthly part is sourced; I found nothing on good/better/best packages, anchoring, or telematics framing for auto quotes.

### Cited Findings
- Paid-in-full discounts are commonly cited at 2-5% of premium, sometimes 10-20% or up to 25-30%; installment plans often add fees; lapse risk is higher with monthly billing. Consumer-advice sources, not conversion studies. — [MoneyGeek](https://www.moneygeek.com/insurance/auto/monthly-vs-annual-car-insurance-payments/), [Experian](https://experian.com/blogs/ask-experian/should-you-pay-car-insurance-in-full-or-monthly), [Bankrate](https://www.bankrate.com/insurance/car/pay-car-insurance-in-installments)

### Inferences
- State both monthly and paid-in-full totals with installment fee and discount explicit; offering 2-3 coverage tiers is standard practice but its conversion lift is unverified here.

### Gaps
- Package/anchoring lift, discount-surfacing effect, telematics framing: no sources found.

## 5. Abandoned-quote recovery and saved-quote resume

### Takeaway
Evidence is vendor-only: fast outreach (minutes) and a resume-where-you-left-off link are the repeated levers. No audited recovery rates.

### Cited Findings
- OpenDialog "Rhea" (Oct 2025) re-engages abandoned quotes over WhatsApp/SMS and lets customers resume exactly where they left off; no insurance lift published. Its retail analogy: cart-abandonment messages recover 5-10%, up to 65% if timely. — [FinTech Global](https://fintech.global/2025/10/27/opendialog-launches-rhea-to-re-engage-insurance-leads/)
- Email reminders criticized as arriving too late relative to abandonment. — [Kommunicate](https://www.kommunicate.io/blog/conversational-ai-insurance-conversion-rates/) (search-snippet; vendor)

### Inferences
- Persist the application under a short reference code so SMS can deep-link to resume or the caller can call back and resume; the existing returning-caller DOB-verified code design matches this pattern.

### Gaps
- No primary data on recovery rate by channel or delay.

## 6. Warm handoff to a licensed human

### Takeaway
No head-to-head live-transfer vs callback data for auto. Vendor/SOP material says three-way introductions lose far fewer leads than cold transfers.

### Cited Findings
- Final-expense agency SOP (unsourced): drop-off about 25-40% cold/blind, 10-20% sequential warm, 2-7% three-way intro; claims 2-3x close uplift for three-way vs cold. Different line of business, anecdotal. — [AgentTech](https://agenttech.io/blog/fe-warm-transfer-agency-sop) (search-snippet)
- Vendors: transfers sent to hold or voicemail are usually lost; conversion decided in first 60 seconds. — [Sonant](https://www.sonant.ai/blog/auto-insurance-live-transfer-leads) (search-snippet)
- bolt AI for Agencies (Oct 2025): human reviews before binding. — [press release](https://markets.financialcontent.com/worldnow.ktul/article/accwirecq-2025-10-15-bolt-launches-ai-for-agencies-to-reduce-quoting-time-and-improve-bind-rates)

### Inferences
- Pass context in the handoff (name, state, vehicles/drivers, chosen package, quoted price, objections, DOB-verified flag) so the specialist does not re-ask; announce the human to the caller before connecting; fall back to a timed callback plus SMS if no one answers. All design judgment.

### Gaps
- Optimal moment to offer a handoff (before or after price) not found.

## 7. Real-world AI voice agents in insurance (2025-2026)

### Takeaway
Many launches, almost no audited outcomes. Only quantified bind claim: bolt says "doubles call-to-bind conversion" (self-reported, no baseline).

### Cited Findings
- bolt "AI for Agencies" (Oct 14-15, 2025): claims doubled call-to-bind, quotes in under 10 minutes vs 30, "up to 67% faster" (conflicts with "three times faster" in the same release); AI receptionist answers calls and chats and routes; agent review required before binding. No baseline or methodology. — [press release](https://markets.financialcontent.com/worldnow.ktul/article/accwirecq-2025-10-15-bolt-launches-ai-for-agencies-to-reduce-quoting-time-and-improve-bind-rates)
- SuperAgent AI launched a quoting AI agent (reported Jan-Feb 2026); announcement only, no results. — [Coverager](https://coverager.com/superagent-ai-launches-quoting-ai-agent/), [FinTech Global](https://fintech.global/2026/01/28/superagent-ai-unveils-fully-autonomous-insurance-solution/)
- Vendor claims (unverified): AI receptionists give 30-45% more quotes from inbound calls; pickup rising from 45-60% to near-complete; 30-40% convert to producer appointment vs 12-20% baseline. — [Ainora](https://ainora.lt/blog/ai-receptionist-for-insurance-agencies), [Ciela](https://ciela.ai/agents/ai-receptionist-for-insurance-agencies) (search-snippets)
- Some vendors deliberately do not generate quotes by voice and book a consultation instead. — vendor pages above (search-snippet)
- 15-25% bind-to-quote improvement claim from Tars; anonymous, unnamed agencies. — [Hellotars](https://hellotars.com/ai-agents/insurance-products-quote-request-ai-agent)

### Inferences
- Missed-call capture and after-hours pickup are the most credible mechanism for AI voice lift; the demo line's differentiator is that it actually rates, which most cited vendors avoid.

### Gaps
- No named carrier/agency deployment with audited bind results; no McKinsey source verified (a Sonant post attributes ~30% opex reduction to McKinsey, unchecked).

## Cross-cutting notes for the NJ/PA/MI demo
- Treat all vendor lifts as hypotheses; instrument own funnel (application started, quote read, handoff accepted, bound) and compare callback-delay and SMS variants.
- Best-supported levers by evidence strength: human involvement (J.D. Power 33% vs 10%), speed of follow-up (directional), frictionless resume link (directional), warm 3-way handoff (anecdotal).
