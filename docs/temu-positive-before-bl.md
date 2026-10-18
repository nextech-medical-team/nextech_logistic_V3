# TEMU: purchase a missing label as soon as the quoted margin is positive

Historical instruction, superseded on 18 October 2026: new purchases now wait
for BL creation. See [the current policy](temu-label-after-bl.md).

Human decision of 16 October 2026: TEMU label purchase must not wait for a BC,
BL, available stock, ERP validation or completion of an imported order's
preparation. This is TEMU-only. The legacy `simulation` flag on an Excel import
is not proof of a supplier sandbox; actual order/shop identity is still read
from TEMU before a quote or purchase.

The worker now discovers untouched missing/API-error/import jobs independently
of ERP, and remains enabled independently of `automatic-preparation`. It first
recovers an existing supplier parcel/PDF, then obtains a fresh quote and matches
the current financial margin to that quote. Profit must be strictly positive
both on admission and immediately before the durable purchase claim. Financial
source, address, suspension, weight and line data remain bound to that decision.
ERP progress, stock warnings and obsolete preparation flags are not conditions.

Suspensions, explicit cancellation, shipped/delivered orders, existing external
transport choices, partial delivery workflows, paid labels, documents and
uncertain attempts remain protected. No order data is imported from the API,
and no BC/BL, stock, marketplace address, saved label or tracking is rewritten.
Historical orders use the same policy as new imports and are never reset in
bulk. A purchase error of uncertain outcome is recovered, never automatically
repeated.

The native shipping service now has a financial authority independent of a BL.
The same database claim preserves uniqueness and records a
`positive-margin-without-bl-v2` decision. Other channel implementations and
their preparation gates are unchanged. Explicit manual confirmation retains
its existing meaning; the automatic/historical worker requires positive margin.

Validation uses an isolated PostgreSQL-compatible database and synthetic
supplier APIs, including the historical LV order with no BL, missing stock,
an ERP review, legacy simulation, stale preparation and positive margin. Tests
cover zero/negative/unknown margins, changed financial inputs, concurrent ERP
progress, duplicate parcels, explicit suspension, every other channel and
an uncertain provider response. Production remediation is separately audited.
Publish through Section7 after fresh server baseline and exact CI. Roll back
only changed runtime files under the normal controls; do not restore supplier
or database business state.
