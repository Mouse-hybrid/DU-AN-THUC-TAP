# PLN-QA-03 — QA/QC Sprint 3 planning baseline

**Date:** 26/10/2026 (VN)  
**Window:** 26/10–06/11/2026  
**Status:** In progress — draft pending PO/BE/FE/CRM decisions. This is a planning baseline, not a business test result or sign-off.

## 1. Verified starting point

- QA Project Plan, `Checklist_QAQC`, rows 87–102: PLN-QA-03 → DES-QA-07 → ENV-QA-04 → EXE-QA-06 → business test tasks.
- `AFG_POS_QR_Ordering_TestCases_24_v0.2_2026-10-19.xlsx`: QR-001..024, 16 Critical + 8 High, all Not Executed.
- `AFG_POS_Rewards_TestCases_20_v0.2_2026-10-19.xlsx`: RW-001..020, 15 Critical + 5 High, all Not Executed.
- Separate `AFG_POS_QAQC_Phase2_Testcase_Design_2026-10-25.xlsx` covers eight BRD groups and does **not** supersede the 24/20 module baselines.
- DES-QA-07 GET-only observation on staging commit `46d6049b7228bfe023a42c84269fb3fb8464be63`: 31 OpenAPI paths, 35 REST operations, no named QR/Rewards/multi-method payments/advanced table/modifier/inventory operations. Evidence: `evidence/DES-QA-07/DES_QA_07_LIVE_2026-10-26.json`. This is a preflight result, not a business PASS.
- BE `docs/api/api-catalog.md` §D labels Phase 2 routes as proposals, not implemented contracts. Recheck `/version` and live `/openapi.json` together after deployment. No QR/Rewards/Sprint-3-named branch was found in the 26/10 branch inventory; branch names alone do not prove deployment status.

## 2. Proposed priority and sequence (PO to approve)

| Priority | Scope | Case baseline | Earliest gate |
| --- | --- | --- | --- |
| P0 | QR public flow, token/session binding, zero login, request_id retry, dual-device and POS coexistence, stock exclusion, KDS routing, billing lock | QR-001..015, 019–020 first; then remaining QR cases by contract | BE QR contract + FE public route + isolated table/token/item fixture |
| P0 | Rewards lookup, optional member, eligibility, apply/redeem, no double deduction, CRM fallback and privacy | RW-001, 003–013, 015, 017, 020 first; then remaining RW cases | PO/CRM rule version + BE schema + member/points fixture |
| P0 dependency | Billing and payment failure/UNKNOWN, no double charge, reward reversal | QR-014, RW-010..012, 016–019 and Phase 2 payment cases | Gateway sandbox and Finance/PO error-state policy |
| P1 / decision | Table merge/split/transfer, staff roles, audit export, Sentry, basic modifier | Phase 2 broader design; schedule only after owner/contract decision | PO scope and BE/FE contract |
| Scope decision | Inventory/BOM, negative stock, offline chaos | TSK-QA-014/015 in Project Plan | PO confirms Sprint 3 vs later; BE catalog currently proposes inventory/BOM in Phase 3 |

The board covers all Phase 2 through Sprint 3–4 (26/10–20/11). This two-week QA plan must not assume every Phase 2 module is delivered by 06/11.

## 3. Definition of Done proposed for PLN-QA-03

1. PO records Sprint 3 in-scope/carryover decision and priority for QR, Rewards, payment, modifier, inventory/BOM and advanced table operations.
2. BE identifies each implemented endpoint's PR/commit, request/response schema, auth/RBAC, idempotency, error responses and staging SHA; QA inventories the live OpenAPI from the same SHA.
3. FE confirms customer QR and Rewards UI route, integration point, role behavior and deployment; the POS Rollout Board labels FE work as inference until FE confirms.
4. PO/CRM/Finance approves QR token/session and member/reward/payment policy, including failure and reversal rules; do not invent a discount cap.
5. ENV-QA-04 has a named owner, isolated seed, reset/cleanup method and sandbox access before any write test.
6. Every QR-001..024 and RW-001..020 receives a contract/requirement link and disposition (`Ready`, `Blocked by named dependency`, or `Deferred by PO`). Execution status stays Not Executed until its own test runs.

## 4. Execution gates and schedule

| Date target | Task | Gate/output |
| --- | --- | --- |
| 26–27/10 | DES-QA-07 / PLN-QA-03 | Live version/OpenAPI inventory; trace BRD → 24/20 cases → proposed/implemented routes; PO/BE/CRM decisions logged |
| 27–28/10 | ENV-QA-04 | Fixture IDs, ownership, two-device setup, CRM/payment sandbox, cleanup dry run |
| 28/10 | EXE-QA-06 | Read-only health/version/OpenAPI and route readiness on an identified build; no business PASS from smoke |
| 29/10–04/11 | TSK-QA-012 / EXE-QA-07 | Execute ready QR/Rewards cases; each run records SHA, IDs, HTTP/UI evidence and cleanup |
| 02–05/11 | TSK-QA-013 / EXE-QA-08 | Payment/billing and cross-module regression on one integrated build if contracts/fixtures are ready |
| 05–06/11 | QA-FREEZE / REL-QA-03 | Actual Passed/Failed/Blocked/Not Executed counts, P0/P1 defect disposition, carryover owner/date |

## 5. Decisions still open

- QR-RFI-01..05: token TTL/revoke; cart idle; ≤30-second measurement; order/session model, request_id and retry; modifier/course/OOS race.
- RW-RFI-01..05: earn/redeem/expiry and consent; promotion cap/version; stacking/override/reversal; timeout/fallback; API/ledger/errors and sandbox.
- RFI-SIT-01: deployed SHA, customer/KDS UI, CRM/payment sandbox, outlet/fixtures and cleanup owner.
- Phase 2 vs Sprint 3 scope: basic QR/POS modifier, Inventory/BOM, offline, advanced table and multi-method payment order of delivery.

## 6. ENV-QA-04 handoff — fixture request, no mutation yet

| Fixture | Minimum required | Isolation/cleanup check |
| --- | --- | --- |
| Table/QR | Own available QA table, opened session, valid/expired/revoked/wrong-table token | Verify session/table/order ownership before use; release only own session |
| Two devices | Two browser contexts with same table QR and distinct request IDs | No unrelated table/order changes; verify one result per request ID |
| Menu/KDS | Mapped available item plus controlled unavailable/OOS item, stations | Restore QA-owned availability and verify tickets/order IDs |
| POS coexistence | Waiter/Supervisor test users and own order in same session | Verify QR + POS association, then close/pay/clean only own fixture |
| Rewards | Member with points, member without points, nonmember; ledger baseline | Restore or reset QA member/points and reconcile earn/redeem/reversal |
| Payment | Sandbox success, failure, timeout/UNKNOWN and signed callback fixtures | No real charge; reconcile payment attempts, order state and reward ledger |

**Gate:** no QR/Rewards/payment write request until BE/PO/CRM confirms the specific contract, fixture ownership, and cleanup path. Do not reset shared staging as a substitute for isolated cleanup.
