# Sprint 2 — QA/QC Day 1 Contract Review (2026-10-12)

**Scope:** `PLN-QA-02` (Sprint 2 planning, 1.5h estimate) and `DES-QA-04` (KDS / WebSocket / order version review, 2h estimate).

**Status:** QA desk review started; BE/PO/BA approvals pending. **No mutation, no new functional test PASS, and no actual-hours claim.**

## Source baseline
- `Project_Plan (1).xlsx`, `Checklist_QAQC` rows 74–84: Sprint 2 QA plan.
- `AFG_POS_Kế_Hoạch_Thực_Hiện_Theo_Sprint_Chi_Tiết.docx`: Sprint 2 BE-S2-01..08 and TSK-QA-009..011.
- `01_SRS_AFG_POS_OFFICIAL_v1.0.docx`: functional/security requirements and KDS WebSocket latency <=2s.
- `POS_Backend_Implementation_Specification.docx`: proposed optimistic-locking conflict handling and idempotency.
- QA Postman Collections: `AFG_POS_QA_Automation_to_KDS_005_011`, `AFG_POS_TC_API_12_001_to_15_002_Kitchen_State_Automation`, `AFG_POS_TC_PM_10_TO_23_MENU_CRUD_STANDALONE_V1`.
- Cypress: `tc_ext_010_void_contract_preflight.cy.js`, `tc_ext_012_013_refire_preflight.cy.js`, `tc_ext_014_kitchen_sla.cy.js`, `tc_ext_015_ws_no_jwt.cy.js`, `tc_ext_016_017_ws_contract_preflight.cy.js`, `tc_ext_020_full_e2e.cy.js`.

A file's presence is **not proof** that its contract is deployed or that the expected result passed.

## Findings and mappings

| Scope | Available evidence | Gap / confirmation required |
| --- | --- | --- |
| BE-S2-01 order_version | SRS refers to `version_no`, optimistic locking and HTTP 409; staging Order GETs observed `current_version` | Determine authoritative request/response schema, conflict payload, audit and authorization. |
| BE-S2-02 table_session | Order/Table APIs; interrupted QA B2 recovery reached Order `PAID` | Require read-only proof of `CLOSED` / `CLEANING` / `AVAILABLE` and approved cleanup runbook before new mutations. |
| BE-S2-03 WebSocket | TC_EXT_015 observed unauthorized WS handshake denied 403 | Obtain ADR-0002, JWT transport, event types/payloads, event order and reconnect/resync policy. |
| BE-S2-04 KDS | Postman has `GET /api/v1/kitchen/queue`, `start-cooking`, `mark-ready`, `pickup`, `served` | Confirm 6-station routing and modifier rules, actual queue schema, kitchen fixture and Expeditor behavior. |
| BE-S2-05/06 Menu/Category | Menu CRUD and Category Postman collections; TC_EXT_003/004 previously reported Passed | Confirm API deploy/version, allowed test data, cleanup rules and smoke gate. |
| BE-S2-07 Idempotency/audit | SRS says `X-Request-Id`; current QA tests/collections use `Idempotency-Key` | Identify canonical header, replay semantics and audit log schema. |
| KDS SLA/Refire | TC_EXT_012–014 preflights Pending; Refire candidate path in Postman | Confirm Refire contract and fixture; time origin and exact SLA thresholds/fields. |
| CI | `.github/workflows/playwright-api.yml` configured for ONLY_TESTING; user screenshot showed workflow #46 Failed | Obtain job log and classify actual failing step, without assuming Backend fault. |

### Scope discrepancy to resolve
`Checklist_QAQC` uses:
- `TSK-QA-010` for SLA Timer + Expeditor,
- `TSK-QA-011` for Order Version / Void / Table lifecycle.

Sprint 2 detailed plan uses:
- `TSK-QA-010` for Expeditor + Refire,
- `TSK-QA-011` for SLA BVA.

Do not silently remap IDs until the Product/BA/QA owners approve the definitive Sprint 2 mapping.

## Open RFI (do not infer answers)
| RFI | Priority | Question / Deliverable | Requested from |
| --- | --- | --- | --- |
| S2-RFI-01 | P0 | M2 scope / DoD and duplicate task-ID mapping | PO, BA, BE |
| S2-RFI-02 | P0 | version_no vs current_version, X-Request-Id vs Idempotency-Key, HTTP 409 and audit | BE |
| S2-RFI-03 | P0 | ADR-0002, WebSocket JWT/event schema/reconnect | BE, FE |
| S2-RFI-04 | P0 | Six KDS station assignments, modifier split, queue and Expeditor contract | BE, BA, Kitchen |
| S2-RFI-05 | P0 | SLA 8/12/15 minute clock, fixtures, Refire -R1 and duplicate prevention | BE, BA |
| S2-RFI-06 | P1 | Menu/category CRUD OpenAPI version and safe fixture cleanup | BE |
| S2-RFI-07 | P0 | B2 QA session cleanup, simulated-pay guarantee and reset mechanism | BE, QA |
| S2-RFI-08 | P1 | Playwright Actions #46 first failing step/root cause | DevOps, QA |
| S2-RFI-09 | P1 | 6 KDS stations vs four Tab S9 devices in test lab | QA, DevOps, BE |

## QA acceptance gate / next actions
- **PLN-QA-02:** pending PO/BA/BE confirmation of Sprint scope, DoD and M2 gate.
- **DES-QA-04:** review materials prepared; pending authoritative ADR-0002/OpenAPI/version contract.
- **Next day (2026-10-13):** prepare `DES-QA-05` decision-table tests for six-station KDS routing and Refire based on confirmed rules. Draft assumptions can be labeled, not counted as tested.
- **Safety:** do not auto-run mutating Cypress specs or Postman recovery on any push; wait for fixture/cleanup approval.

Linked working workbook (local delivery): `Project_Plan_Sprint2_Day1_12-10_2026.xlsx` has sheets `S2_Day1_12-10`, `S2_Contract_Trace`, and `S2_RFI_Register`.
