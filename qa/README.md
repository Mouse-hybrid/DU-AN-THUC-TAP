# QA/QC Workspace

Branch: `ONLY_TESTING`

This branch is the long-lived QA/QC workspace for the POS_SYSTEM project.
It is created once and maintained throughout the project lifecycle.

## Purpose

- Store QA/QC test assets and execution records.
- Keep QA evidence separate from application implementation branches.
- Record environment readiness, smoke testing, functional testing, regression testing, defects, evidence, and reports.

## Structure

```
qa/
├── environment/
├── smoke/
├── functional/
├── regression/
├── defects/
├── evidence/
└── reports/
```

## Rules

1. Do not create task-ID folders such as `EXE-QA-01`.
2. Do not modify application code only to make a QA test pass.
3. Keep real passwords, tokens, secrets, and private keys out of this branch.
4. Every executed test should have status and evidence recorded.
5. Keep QA artifacts traceable to the tested build/commit/environment.
6. Use this branch for QA/QC artifacts throughout the POS_SYSTEM project.

## Status values

- NOT EXECUTED
- PASS
- FAIL
- BLOCKED
- RETEST
- CONDITIONAL
