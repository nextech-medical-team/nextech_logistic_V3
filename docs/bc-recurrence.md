# BC comparison recurrence

Document refresh now recalculates product SKUs and quantities from the current preparation mapping, including partial orders. It reconciles only exact historical physical comparison errors, preserves their original evidence, and restores a detailed error when a later read diverges. Other errors, job statuses, source lines, supplier documents and labels remain unchanged. ERP variant identity failures remain protected because SKU concordance alone does not certify variant identity.

The periodic monitor may read a pending ERP order only when its existing BC and pending validation prevent the ERP worker from claiming it. Processing jobs and active corrections remain excluded. An automatic resume requires the successful fresh comparison plus all existing stock, pricing, suspension, preview and document safeguards. Partial and unconfirmed comparisons cannot start preparation. Concurrent refresh responses use a canonical version check and transactional reconciliation.

Tests cover supplier read failures, malformed or paginated documents, races, rollback, current mappings, repeated checks, preserved finance and labels, renewed differences, and real PostgreSQL selection/resume guards. Fixtures contain no customer contact/address data. Publication and installed validation are performed through Section7.
