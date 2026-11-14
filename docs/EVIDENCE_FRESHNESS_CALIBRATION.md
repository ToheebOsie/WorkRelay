# Evidence freshness calibration

**Calibration snapshot:** 14 November 2026  
**Status:** evidence-informed starting policy; deployment/task-specific calibration still required.

## Why one age limit is not enough

The official Nigeria publisher landscape contains different publication cadences on the same host:

- CBN's Data & Statistics index lists daily series, exchange-rate and financial data, and annual/quarterly statistical bulletins; its publications index lists monthly, quarterly and annual outputs.
- NBS's 2026–2028 Service Charter says outputs follow an approved Data Release Calendar, including monthly, quarterly and annual publications such as CPI, GDP and socio-economic reports.
- SEC's official site exposes monthly net-asset-value data, quarterly PE/infrastructure-fund data, and rules/circulars that can be amended.
- NGX describes real-time, end-of-day, reference and historical data, while its X-Factbook is annual.

Accordingly, a claim's declared series cadence is more useful than a generic `financial` or `market` label when evaluating published values.

## Implemented cadence profiles

Claim types are declarations supplied by the evidence workflow; WorkRelay does not infer cadence from a publisher hostname or from article prose.

| Claim type | Max publication age | Max capture age | Intended use |
|---|---:|---:|---|
| `daily_series` | 7 days | 2 days | A source series explicitly published daily; the grace window allows weekends/holidays and publication lag |
| `monthly_series` | 60 days | 14 days | Monthly releases such as CPI or monthly market/industry reporting |
| `quarterly_series` | 150 days | 30 days | Quarterly indicators and quarterly institutional releases |
| `annual_series` | 550 days | 90 days | Annual reports, annual datasets and annual factbooks |

These are WorkRelay operating tolerances, not official NBS/CBN/SEC deadlines and not externally established standards. A deployment should tighten or widen them only with a documented reason tied to the actual series calendar, release delay, revision practices and decision use. Where a source has an authoritative release calendar, capture the actual expected date and report delay rather than assuming the nominal period alone.

Existing generic claim types (`financial`, `numeric`, `market`, `regulatory`) retain their earlier defaults for compatibility.

## Current regulatory status is a different question

For claims explicitly typed `regulatory_current`, publication age is not treated as a proxy for whether an instrument remains in force. A law or rule can remain effective for years, and a recent rule can already have been amended. WorkRelay therefore:

1. still requires a publication timestamp to identify the source/version;
2. requires a recent capture (30-day maximum by default);
3. requires a packet-bound human claim finding that declares the current consolidated version/status was checked and that relevant amendments, repeals or superseding instruments were considered;
4. records that declaration separately as `regulatory_current_status`.

This is a reviewer attestation, not authenticated identity, a legal opinion, automated legal research or proof that no later instrument exists. The reviewer should consult the issuing authority's current register, consolidated rules/acts, gazette or official amendments and cite the exact materials in the review notes. Authenticated identity and durable review records remain Step 8 work.

The legacy claim type `regulatory` retains its existing publication-age policy. Use `regulatory_current` when the actual claim is about current in-force status.

## Operational guidance

- Classify at the claim level, not by publisher alone. A CBN page may contain daily series, monthly statistics, quarterly reports and event-driven circulars.
- Use the underlying observation period and publication date separately. Do not substitute an observation-period end date for the publication timestamp.
- Capture recent source bytes before review; retrieval age is independent of publication age.
- For revised datasets, preserve the version or revision date and explain which vintage supports the claim.
- Missing publication dates remain review-required even for regulatory-current claims.
- A freshness pass means only that the timestamps fit the configured window. It does not establish accuracy, relevance, completeness or that a dataset has not been revised.
