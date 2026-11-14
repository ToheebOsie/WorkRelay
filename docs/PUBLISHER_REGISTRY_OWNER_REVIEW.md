# Deployment-owner worksheet — Nigeria fintech publisher candidates

**Status:** All candidates remain inactive. This worksheet records review decisions; it does not create or activate an authority registry.

For each exact hostname, the deployment owner should confirm the domain, issuer, source scope, permitted claim types, publisher group, authority tier, supporting basis and expiry. An approval here is not sufficient by itself: the owner must then explicitly create and commit a v2 registry using `commitPublisherAuthorityRegistry()` and a reviewer identity that is authenticated once Step 8 identity controls exist.

| Exact host | Publisher | Proposed tier | Publisher group | Permitted claim types | Owner decision |
|---|---|---|---|---|---|
| `cbn.gov.ng` | Central Bank of Nigeria | `regulator` | `central-bank-of-nigeria` | `financial`, `numeric`, `market`, `regulatory`, `regulatory_current`, `daily_series`, `monthly_series`, `quarterly_series`, `annual_series` | **PENDING** |
| `statistics.cbn.gov.ng` | Central Bank of Nigeria — Statistics Database | `primary` | `central-bank-of-nigeria` | `financial`, `numeric`, `market`, `daily_series`, `monthly_series`, `quarterly_series`, `annual_series` | **PENDING** |
| `nigerianstat.gov.ng` | National Bureau of Statistics | `primary` | `national-bureau-of-statistics` | `numeric`, `market`, `monthly_series`, `quarterly_series`, `annual_series` | **PENDING** |
| `www.nigerianstat.gov.ng` | National Bureau of Statistics | `primary` | `national-bureau-of-statistics` | `numeric`, `market`, `monthly_series`, `quarterly_series`, `annual_series` | **PENDING** |
| `sec.gov.ng` | Securities and Exchange Commission Nigeria | `regulator` | `securities-and-exchange-commission-nigeria` | `financial`, `numeric`, `market`, `regulatory`, `regulatory_current`, `monthly_series`, `quarterly_series` | **PENDING** |
| `ndic.gov.ng` | Nigeria Deposit Insurance Corporation | `primary` | `nigeria-deposit-insurance-corporation` | `financial`, `numeric`, `quarterly_series`, `annual_series` | **PENDING** |
| `ndpc.gov.ng` | Nigeria Data Protection Commission | `regulator` | `nigeria-data-protection-commission` | `regulatory`, `regulatory_current` | **PENDING** |
| `nibss-plc.com.ng` | Nigeria Inter-Bank Settlement System Plc | `primary` | `nigeria-inter-bank-settlement-system` | `financial`, `numeric`, `market`, `daily_series`, `monthly_series`, `quarterly_series`, `annual_series` | **PENDING** |
| `ngxgroup.com` | Nigerian Exchange Group / Nigerian Exchange | `primary` | `nigerian-exchange-group` | `financial`, `numeric`, `market`, `daily_series`, `monthly_series`, `quarterly_series`, `annual_series` | **PENDING** |

## Review record to complete for every candidate

- Exact hostname verified: pending
- Publisher identity and official control of hostname verified: pending
- Human-readable subject scope accepted or amended: pending
- Permitted claim types accepted or amended: pending
- Authority tier justified for this remit: pending
- Publisher group / alias relationship reviewed: pending
- Supporting basis checked against current official pages: pending
- `reviewedAt`, `validUntil`, reviewer and version chosen: pending
- Explicit decision and reason: pending

## Non-negotiable controls

- Do not infer trust from domain suffixes, HTTPS, search ranking or institutional name alone.
- Do not promote a candidate because it appears in this pack or because the validation script passes.
- Keep exact-host matching; do not add wildcard or suffix rules.
- Preserve the scope and permitted-claim-type allowlist in every active v2 registry entry.
- Treat `cbn.gov.ng` and `statistics.cbn.gov.ng` as the same publisher group for corroboration. Treat `nigerianstat.gov.ng` and `www.nigerianstat.gov.ng` as the same publisher group.
- Review the documented CBN/NIBSS governance affiliation on a claim-by-claim basis; separate group labels do not by themselves establish independent corroboration.
- No candidate is activated until the deployment owner explicitly approves it and a v2 registry record is committed.

## Candidate source pack

See `config/publisher-authority-candidates.nigeria-fintech.json` and `docs/PUBLISHER_REGISTRY_RESEARCH_NIGERIA_FINTECH.md` for supporting sources and rationale.
