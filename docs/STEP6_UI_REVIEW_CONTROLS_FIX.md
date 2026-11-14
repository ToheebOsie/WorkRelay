# Step 6 UI review-control wiring correction

Date: 2026-11-14

## Defect

The simulation execution renderer created buttons for structural evaluation and human review, but the rendered controls had no click handlers. As a result, the browser workflow could stop after simulated deliverables were returned. The server already exposed `POST /api/evaluate` and `POST /api/review`; the missing link was in `public/app.js`.

## Correction

The client now attaches handlers after each `renderExecution()` update because the package cards are rebuilt with `innerHTML`. Structural evaluation calls `/api/evaluate`. Accept and revision decisions call `/api/review`. Acceptance requires an explicit confirmation that explains it records human acceptance only and is not factual verification or payment authorization. Errors are displayed in the execution warning area and restore the control for retry.

## Scope and limitations

This is a targeted frontend wiring correction. It does not enable live commissioning, wallet access, signing or settlement. It has not been represented as browser-tested. Step 6 still requires a real browser run of the complete journey and sandbox branches, with console/network, responsive and accessibility checks.
