# Preserve the installed stock diagnostic during deployment

Publishing `2d1fc17` failed before installation or service suspension because
`public/compact-problems.js` contains the recorded overlay from `4917bf7`.
The baseline inventory matches production, but its Git commit lacks that overlay.

The candidate keeps the installed suppression of the redundant BC stock waiting
notice and the customer diagnostic grouping added on main. The deployment planner
can reconcile an overlay only when its root-owned baseline record, current file
hash and exact source Git blob agree. A three-way comparison must reproduce the
candidate exactly, proving it retains the installed change. Conflicts, lost fixes,
unknown/private differences and concurrent server edits still block publication.
Comparison splits compact JavaScript at semicolons and braces; it never executes
or rewrites candidate code. Reconciled paths and provenance enter the deployment
report. Baseline hashes are not rewritten to bypass a conflict.

Section 7 must install the reviewed `plan.py` change and the three dispatcher
integration lines under the publication lock, preserving server-specific runtime
changes, backing up both trusted files and checking their approved hashes. A
repository merge alone does not update the privileged executor. Certify prior
pre-install failures using the existing server restoration certificate, preserving
all local queue entries, then publish the new main commit through the manual
workflow. Normal candidate tests, queue, backups, service controls and rollback
remain active. No business data or supplier writes are required for reconciliation.

Validation: targeted application regressions; planner rejection cases for lost
overlays, conflicts, drift, wrong Git provenance, missing metadata and deletion;
comparison of the actual fba78d8/4917bf7 blobs with the merged candidate. The Windows
launcher test cannot execute a Linux shebang; the complete deployment suite must
also pass on Linux before trusted executor installation.
