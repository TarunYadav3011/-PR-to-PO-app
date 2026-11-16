# DECISIONS.md — assumptions and gaps

## Source material available
- `Cantill_FullStack_Task_Brief.pdf`
- `Worked_Examples.pdf`

The task brief says the full kit additionally contains `Corvo_Procurement_Policy.pdf`, 73-item item master, 48-supplier master, PO history (~525 POs), plant data, contract register/lines and signed contract PDFs, plus a 186-line sample PR CSV. Those files were not present in the supplied uploads.

## Decisions extracted from worked examples (not a substitute for policy v5.0)
1. Capex routes to `CAPEX_SOURCING` and is checked before contracts/value limits (example 12).
2. Items absent from the item master route to `NEW_ITEM_SOURCING`, are valued at requester estimate, are not clubbed and have no supplier suggestions (example 13).
3. A valid contract with available ceiling can route to `CONTRACT_PO` regardless of value (example 1).
4. A signed PDF-only contract can apply even if absent from the register, if valid on the requirement date (example 2).
5. A contract whose remaining ceiling is insufficient cannot be used (example 3); among multiple contracts, choose the lowest-rate contract that still has ceiling room (example 4).
6. Same item + same plant PR lines club when raised within 14 days and need-by dates are within 7 days (example 5); different plants are not clubbed (example 6).
7. Emergency requirements up to ₹5 lakh with purchase history may use `EMERGENCY_PO` (example 8).
8. Normal spot PO example is below ₹2 lakh and has an Active-supplier purchase in the last 365 days (example 7). Example 10 shows a low-value item with no Active supplier purchase in 365 days routes to RFQ.
9. Example 9 routes ₹2 lakh to below ₹10 lakh to RFQ with 3 suggestions. Example 11 routes ₹10 lakh or above to RFP with 5 suggestions.
10. Example 14 consolidates eligible requirements into one PO when supplier, plant and route match and they were raised within 24 hours of the first one.

## Explicit assumptions in this starter
- Because the full policy is absent, only a subset of the above examples is encoded as a partial ordered policy. Contract checks are not implemented, so this version must not be used to authorize real POs.
- The demo parser only extracts a numeric quantity and plant hints for PUN1/CHK1. It does not pretend to resolve item identity from free text.
- If no configured rule matches, the conservative fallback is sourcing review.
- Supplier suggestions use active suppliers with item PO history, ordered by PO count, latest PO and rating. This is only a placeholder; final ranking should incorporate the policy's exact factors and explain each supplier score.
- The policy upload endpoint accepts JSON, not PDF. This avoids pretending that arbitrary PDF text has been converted into safe executable rules. Add PDF extraction, structured diff and human validation before activation.
- Approval is logged but no ERP PO/RFQ integration is available in the provided starter.

## Required before a scored/production run
- Obtain full Procurement Policy v5.0 and implement its exact ordered clauses and definitions.
- Load item/supplier/plant masters, all PO history, contract register and every signed PDF-only contract.
- Implement item matching, requirement clubbing, valuation, contract ceilings, supplier ranking, sourcing suggestions, and PO consolidation.
- Validate against all 14 worked examples and the complete sample PR batch; then add automated regression tests.
