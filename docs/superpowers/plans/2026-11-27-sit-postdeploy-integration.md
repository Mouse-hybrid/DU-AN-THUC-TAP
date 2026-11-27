# SIT after three QA gates implementation plan

> Execute directly in this session. User authorized review, integration, negative checks and handoff on 27/11/2026.

**Goal** — Run the reviewed 16-step SIT after the existing three gates, with a nonzero result on test or cleanup failure and attributable artifacts.

**Architecture** — Merge the reusable SIT entry point and evidence validator into ONLY_TESTING through PR #113. A separate main-branch PR adds a dependent reusable-workflow job after verify-staging. Pin the called workflow to the reviewed immutable QA commit. Pass the deployed application SHA and the QA checkout SHA recorded by the gate job. Keep historical baselines distinct from fresh SIT.

**Stack** — GitHub Actions, Playwright 1.63.0 Docker, Node built-in test runner.

## Constraints
- Application target starts at d6ee04a173c74530653c5df394dd439c92369eaf. Integration into main changes the deployed SHA, which must be passed dynamically.
- Secret S2_STAGING_PIN is forwarded only to the browser test step and never logged or changed.
- SIT mutations remain owned QA3 fixtures with cleanup. Reuse the staging concurrency lock.
- No continue-on-error for execution, validation or final outcome.
- Artifact upload and summary run even when execution or validation fails.
- UI/API coverage remains the reviewed scope; no new all-UI or UAT claim.

## Review focus
- Missing/skipped SIT must not create a green post-deploy outcome.
- Forged overall PASSED with a failed step or cleanup=false must be rejected.
- Application SHA and QA code SHA must be recorded separately.
- Interrupted sandbox actions must have bounded waits and a container termination trap.
- Failed-run reports remain immutable; negative probes have no staging login or mutation.

## Task 1 — Reusable SIT and evidence gate
Files
- Modify .github/workflows/sit-pos-16.yml
- Modify qa/automation/Testing_POS/test_playwright_version/sit_pos_001_16_steps.spec.ts only for bounded anonymous-page waits
- Create qa/automation/Testing_POS/scripts/check_sit_gate.mjs
- Create qa/automation/Testing_POS/scripts/check_sit_gate.test.mjs

- [x] Add CLI tests for a real passed report, forged failed step, cleanup failure, missing report, SHA mismatch, missing step and duplicate step.
- [x] Verify tests fail before implementing the validator.
- [x] Implement report validation with one current root-level report, all 16 unique expected IDs, Passed result, cleanup and matching stable build, no recorded secrets.
- [x] Write summary and SIT_GATE.json before exiting on invalid evidence.
- [x] Add workflow_call and workflow_dispatch inputs for expected_commit and qa_ref, required PIN, exact checkout verification and provenance.
- [x] Keep a nonzero Playwright exit code and always validate/upload reports.
- [x] Run Node tests, YAML/shell checks and Playwright discovery.

## Task 2 — Integrate and prove outcomes
Files
- Modify main .github/workflows/three-gates-postdeploy.yml via a separate PR.
- Create temporary branch workflow .github/workflows/sit-gate-negative-probes.yml only on the negative-probe branch.
- Create qa/automation/Testing_POS/evidence/sit-pos-001/INTEGRATION_20261127.md.

- [x] Review PR #113 changes and checks, mark Ready and merge with an expected-head lease.
- [x] Return qa_sha from the three-gates job.
- [x] Call the pinned reusable SIT after successful gates with the deployed SHA and pinned QA checkout.
- [x] Add an always-running final outcome job that requires both gates and SIT to succeed.
- [x] Run controlled failed-step and cleanup-false CI probes without PIN or staging access and retain their failed conclusions and artifacts.
- [ ] Validate caller YAML and checks, merge the main integration PR and observe Backend CI/deploy and post-deploy gates plus SIT. (PR merged, observation pending.)
- [ ] Download and validate the new-build SIT artifact and record actual SHAs and workflow links in the integration handoff for 30/11.

