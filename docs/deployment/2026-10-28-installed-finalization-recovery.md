# Certify an installed release after a finalization failure

The publication of `95ec40c054d8e0982992560d0aa8733064d472fa` installed its files and advanced the baseline, but its finalization reported `taskControlsRestored: false` and `manualIntervention: true`. The original exception was not recorded. Subsequent read-only checks confirmed the installed inventory, preserved environment, active web/worker services, HTTP 200, and a successful `verify-restored` check.

The existing restoration certificate compares against the pre-install release. It cannot certify this installed state. An explicit installed-release certificate now requires:

- The request, report, verification and current baseline to identify the exact same commit.
- Successful release checks, an installed release, and a finalization failure with no separate installation error or rollback.
- The report's installed hashes to agree with the baseline and the complete current inventory to match it, including deleted files.
- The preserved production environment, healthy services/HTTP, and the strict read-only `verify-restored` control check.
- A valid backup path associated with that exact commit.

This certificate is only used for an explicit resolution. Automatic pre-install failure resolution does not accept this case. Resolution retains the failed report and saves the certificate on the queue request; it does not rewrite the installation or label the original GitHub execution successful. Republishing that same failed/resolved commit remains prohibited. Publish the reviewed correction as a new main commit and use the normal manual workflow.

Finalization failures now record their phase, exception type, and command exit code where applicable, without including arguments or stderr that could contain secrets. Worker capacity preservation and the scheduling checks remain mandatory.

Section 7 must install the reviewed `queue_bridge.py` and `dispatcher.py` under the deployment lock, after verifying their previous hashes and backing them up. The inspected installed versions matched the Git base exactly. Re-run the targeted infrastructure tests on Linux, verify the new hashes and certificate, then explicitly resolve the failed request through the existing queue synchronization mechanism while preserving all local queue entries. A repository merge alone does not install the privileged executor.

Tests cover installed-release certification and refusals for mismatched commits, missing checks, installation/rollback failures, inventory drift, recreated deleted files, bad backup paths, altered environment, unhealthy services, and unrestored controls. Existing queue and capacity-preservation tests remain applicable.
