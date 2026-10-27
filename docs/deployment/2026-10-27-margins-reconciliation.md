# Preserve the installed TEMU equivalent margin corrections

The manual publication of `0dd79da492c882bdb43ecf9df87775712edc062f` stopped before installation or service suspension because `src/margins-service.mjs` differs from the Git baseline `fd9b02a057d2cadd0a6efb7683bc7d7fdab20f91`.

Read-only server inspection confirmed both application services active and HTTPS 200. The installed margin corrections are consistent with the recorded server inventory, but were absent from Git. Their exact sources are recorded in commit `e17a34657e8a45bf105c9bbf48f00dab015c966a`, with these SHA-256 values:

- `src/margins-service.mjs`: `12caf5d89940b1c45dcf9045f480f6a240afacb14fb9bfc2f7c2f77be1e9c35f`.
- `src/temu-equivalent-margin.mjs`: `42eb4a7e087fe5b668bbd8d1d7669d67692e2c6d3333342a6be0dd3d4607e2ec`.

The merged candidate preserves original validated Excel receipts for replacement products and converts foreign receipts using the matching published calculator currency profile. It also preserves main's shipped-preparation costing, invalid-total rejection and cleanup of stale contribution diagnostics. An invalid or missing exchange rate, edited original Excel rows, or inconsistent API totals still prevents a complete margin. Conversion remains an estimate, not a settlement rate.

Before publishing, Section 7 must confirm the inventory and source hashes again under `/var/lock/nextech-deploy.lock`, back up the existing baseline, and record the exact Git provenance for these two existing overlays through `reconciliation.preservedOverlays`. The publication baseline commit and file hashes must not be changed merely to suppress the divergence. The installed planner must prove that the candidate preserves these overlays before accepting the deployment plan. Any other divergence still blocks publication.

Certify pre-install failures only through the existing server restoration checks, preserving local queue entries and failure history. Publish the latest reviewed main through the normal manual pipeline, including its tests, backups, worker controls, rollback and post-install health checks. Source preparation alone does not certify deployment.

Regression coverage includes original Excel replacement receipts, non-EUR API/Excel conversion, missing/mismatched currency profiles, edited source rejection, shipped prepared costs and invalid receipt totals.
