# TEMU parcel weight

Production Excel orders previously always quoted 0.25 kg, even with a greater known weight. Direct imports could also reuse an unexpired quote after their local weight changed. Both paths now use the same known weight, rounded upward to a gram, retaining the existing 0.25 kg floor/fallback and explicit isolated sandbox override. Cached quotes must match this current parcel weight; purchase still recomputes the quote before claiming an attempt.

The reported refusal was TEMU 120015507 (wrong package weight information). Its recorded request used 0.25 kg while V3 recorded 0.405 kg. A later purchase made directly in TEMU declared 25 kg. These observations identify an incorrect V3 weight and different purchase inputs; they do not prove that 0.405 kg alone would be accepted by the carrier. No production purchase is required or allowed as a regression test.

Existing TEMU packages and PDFs are recovered through the native read-only provider path. Never cancel, replace, modify or repurchase them to test this change. No BC/BL/stock/status mutation or migration is included. Post-BL label admission and uncertainty/duplicate protections remain unchanged.

Validation: production Excel known-weight quote and one mocked purchase, kilogram/gram boundaries, preserved explicit sandbox override, cached weight mismatch and subsequent cache hit, uncertain and duplicate attempts. Deploy through Section7 after exact-head CI and server baseline review. Roll back only these two runtime files from current main with normal deployment controls; preserve all documents, supplier results and audit records.
