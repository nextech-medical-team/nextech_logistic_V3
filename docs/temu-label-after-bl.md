# TEMU purchases after BL — 18 October 2026

This human decision supersedes the 16 October before-BL instruction.
A new TEMU purchase requires a recorded BL and fresh strictly positive margin
matched to the selected quote. No additional stock, BC, mapping, fiscal or
preparation check follows the BL. No ERPLAIN status is written by these checks.

The worker filters by created BL and rechecks admission and financial proof
before claim. The native purchase locks the order and checks BL existence and
identity; the financial SQL claim independently requires a valid created BL.
The existing order trigger wakes purchases immediately on BL creation.
An unexpired quote prepared before that BL is refreshed to bind its new BL
authority, avoiding a stale-preview failure on the first automatic pass.
Pending, make_the_shipment, in_preparation and ready_to_ship BLs qualify.
Missing, draft, cancelled or shipped BLs do not qualify. Other channels retain
their existing rules. Existing partial shipment authorities stay in force.

Quotes may be prepared before BL but cannot be purchased without it.
Paid parcel/PDF recovery remains independent of BL. Never clear or replay an
uncertain attempt. Existing labels, tracking, suspensions and history remain.
New financial audit policy is positive-margin-after-bl-v3.

Tests cover positive margin without BL, immediate wake on BL creation,
post-BL stock warnings, negative/zero/unknown margin, removed/cancelled/replaced
BL before claim, manual purchase of pre-BL quote, paid recovery without BL,
uncertain attempts, duplicates and other channels. Section7 alone publishes.
