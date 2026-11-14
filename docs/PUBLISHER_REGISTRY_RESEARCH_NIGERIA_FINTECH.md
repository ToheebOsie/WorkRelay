# Publisher-registry research — Nigeria fintech candidate set

**Research snapshot:** 14 November 2026  
**Status:** candidate research only; not an active or approved authority registry.

This is a deployment-specific starting set for WorkRelay projects about Nigerian fintech, financial infrastructure, capital markets, public statistics and data protection. Every entry remains `requires_deployment_owner_review`. The JSON file under `config/` is deliberately a different schema from `workrelay.publisher-authority-registry.v2`; the evaluator does not load it and it cannot satisfy authority checks.

## Candidate publishers

| Exact host | Publisher group | Proposed tier | Permitted interpretation |
|---|---|---|---|
| `cbn.gov.ng` | `central-bank-of-nigeria` | regulator | CBN-issued rules, circulars, statistics and reports |
| `statistics.cbn.gov.ng` | `central-bank-of-nigeria` | regulator | CBN-hosted statistics database; same group as the CBN apex host |
| `nigerianstat.gov.ng` | `national-bureau-of-statistics` | primary | NBS-issued official statistics and methodology |
| `www.nigerianstat.gov.ng` | `national-bureau-of-statistics` | primary | Exact NBS website alias; same publisher group as the apex host |
| `sec.gov.ng` | `securities-and-exchange-commission-nigeria` | regulator | SEC-issued rules, circulars, fintech rules and operator-register material |
| `ndic.gov.ng` | `nigeria-deposit-insurance-corporation` | primary | NDIC's own deposit-insurance and banking-system reports/data |
| `ndpc.gov.ng` | `nigeria-data-protection-commission` | regulator | NDPC-issued data-protection instruments and notices |
| `nibss-plc.com.ng` | `nigeria-inter-bank-settlement-system` | primary | NIBSS's own payment infrastructure and first-party operational reporting |
| `ngxgroup.com` | `nigerian-exchange-group` | primary | NGX-issued market data, exchange notices and factbook material |

Each candidate includes a human-readable subject scope and a `permittedClaimTypes` allowlist. The active v2 registry must preserve both; the evaluator rejects material claim/source pairs where a registered host does not permit the claim type, and still requires a packet-bound reviewer to assess whether the actual source is in scope. A proposed tier is scoped to a publisher's own remit. It is not an endorsement of every page on the host, every third-party item linked from it, or claims outside that publisher's competence. A registry match is not a factual verdict.

## Research basis

- **Central Bank of Nigeria:** its Data & Statistics page lists daily series, exchange-rate/financial data, a statistics database, annual and quarterly statistical bulletins, and survey reports. Its publications index lists payment-system circulars and guidelines alongside monthly, quarterly and annual reports. This supports using the CBN domain for CBN-issued data and instruments; it does not establish that every series updates daily or that every value is current. Sources: [CBN Data & Statistics](https://www.cbn.gov.ng/rates/) and [CBN Publications/Documents](https://www.cbn.gov.ng/Documents/).
- **National Bureau of Statistics:** the 2026–2028 Service Charter identifies the official NBS website and says statistical outputs follow an approved Data Release Calendar, citing monthly, quarterly and annual publications such as CPI, GDP and other socio-economic reports. It also says calendar tracking occurs daily. This supports cadence-specific claim classes, not a universal fixed release date. Source: [NBS Service Charter 2026–2028](https://nigerianstat.gov.ng/resource/NBS_SERVICE_CHARTER.pdf).
- **Securities and Exchange Commission Nigeria:** its rules page publishes regulations and amendments; the site also exposes monthly net-asset-value data and quarterly PE/infrastructure-fund data in its capital-market data navigation. This confirms multiple release cadences and event-driven changes on the same regulator host. Sources: [SEC Rules and Regulations](https://sec.gov.ng/our-mandate/regulation/rules-and-regulations/) and [SEC Rules for FinTechs](https://sec.gov.ng/our-mandate/regulation/rules-and-regulations/sec-rules-for-fintechs/).
- **Nigeria Deposit Insurance Corporation:** the 2025 Annual Report identifies NDIC as an independent Federal Government agency and contains its own banking-sector tables and financial statements. Source: [NDIC 2025 Annual Report](https://ndic.gov.ng/storage/cms/media/2025-annual-report-2808753c-639b-43b4-bd41-aee19abd399b.pdf).
- **Nigeria Data Protection Commission:** its annual report identifies the Commission and documents regulatory actions, while the Commission hosts the Nigeria Data Protection Act and implementation materials. Sources: [NDPC Annual Report 2024](https://ndpc.gov.ng/wp-content/uploads/2025/01/NDPC-Annual-Report-2024.pdf) and [NDP Act / GAID 2025](https://ndpc.gov.ng/wp-content/uploads/2025/03/NDP-ACT-GAID-2025-MARCH-20TH.pdf).
- **NIBSS:** its own About page says the company is owned by licensed banks including CBN, and describes its inter-bank payment and settlement infrastructure. That first-party status makes it a primary source for its own operations, but not an independent regulator or independent confirmation of CBN reporting. Source: [About NIBSS](https://nibss-plc.com.ng/about-nibss/).
- **Nigerian Exchange Group:** NGX describes licensed real-time market-data feeds and an annual X-Factbook covering listed-company profiles and market statistics. Sources: [NGX Authorized Market Data Vendors](https://ngxgroup.com/exchange/data/vendors-list/) and [NGX Factbook](https://ngxgroup.com/exchange/data/x-factbook/).

## Affiliation review signal: CBN and NIBSS

NIBSS publicly states that it is owned by all licensed banks including CBN, and that a CBN Deputy Governor chairs its board. The candidate pack records this as an affiliation review signal. The two organizations remain separate publisher groups because their legal identities and publications are distinct; however, WorkRelay must not treat one CBN source plus one NIBSS source as independent corroboration merely because the hostnames differ. A reviewer should inspect whether each claim rests on independently collected underlying data and disclose the institutional relationship.

This note is not an ownership graph and should not be generalized to other publishers without separate evidence.

## Promotion to an active registry

A deployment owner must review every exact host, confirm the hostname and scope, decide whether aliases belong to the same publisher group, verify the current publisher remit, select a tier, record a concise evidence basis, choose an expiry date and commit a new registry version using `commitPublisherAuthorityRegistry()` with explicit human confirmation.

Do not copy this candidate file into the active registry as-is. It intentionally lacks a registry version, reviewer, review timestamp, expiry dates and a `confirmed` action. Candidate validation only checks pack integrity; it does not approve a publisher.
