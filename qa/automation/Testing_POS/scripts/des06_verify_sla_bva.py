"""Run deterministic SLA boundary checks against compute_sla from the live staging commit.

This checks backend classification logic, not the staging Queue or KDS UI. No
staging data is changed. Do not count these nine checks as business E2E passes.
"""

from __future__ import annotations

import argparse
import ast
from datetime import datetime, timedelta, timezone
import json
from pathlib import Path
import re
import subprocess
import sys
from urllib.request import urlopen


ROOT = Path(__file__).resolve().parents[4]
THRESHOLDS = {
    "KDS_SLA_WARNING_MINUTES": 8,
    "KDS_SLA_DELAYED_MINUTES": 12,
    "KDS_SLA_CRITICAL_MINUTES": 15,
}
CASES = (
    ("DES06-TC-001", "07:59", 7 * 60 + 59, "NORMAL"),
    ("DES06-TC-002", "08:00", 8 * 60, "WARNING"),
    ("DES06-TC-003", "08:01", 8 * 60 + 1, "WARNING"),
    ("DES06-TC-004", "11:59", 11 * 60 + 59, "WARNING"),
    ("DES06-TC-005", "12:00", 12 * 60, "DELAYED"),
    ("DES06-TC-006", "12:01", 12 * 60 + 1, "DELAYED"),
    ("DES06-TC-007", "14:59", 14 * 60 + 59, "DELAYED"),
    ("DES06-TC-008", "15:00", 15 * 60, "CRITICAL"),
    ("DES06-TC-009", "15:01", 15 * 60 + 1, "CRITICAL"),
)


def git(*args: str) -> str:
    completed = subprocess.run(
        ["git", "-C", str(ROOT), *args], text=True, encoding="utf-8", capture_output=True, check=False
    )
    if completed.returncode:
        raise RuntimeError(f"Git command failed: git {args[0]} (exit {completed.returncode})")
    return completed.stdout


def staging_commit(base_url: str) -> str:
    with urlopen(base_url.rstrip("/") + "/version", timeout=20) as response:
        if response.status != 200:
            raise RuntimeError(f"GET /version returned HTTP {response.status}")
        data = json.load(response)
    commit = data.get("commit", "")
    if not re.fullmatch(r"[0-9a-f]{40}", commit):
        raise RuntimeError("GET /version has no full 40-character commit SHA")
    return commit


def source_for(commit: str, path: str) -> str:
    return git("show", f"{commit}:{path}")


def verify_defaults(source: str) -> None:
    for name, expected in THRESHOLDS.items():
        pattern = rf'{name}\s*=\s*int\(\s*os\.getenv\(\s*"{name}"\s*,\s*"(\d+)"\s*\)\s*\)'
        match = re.search(pattern, source)
        if not match or int(match.group(1)) != expected:
            raise RuntimeError(f"{name} source default differs from DES-QA-06 expected {expected}")


def load_compute_sla(source: str, commit: str):
    tree = ast.parse(source, filename=f"{commit}:backend/app/api/v1/kitchen.py")
    matches = [node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == "compute_sla"]
    if len(matches) != 1:
        raise RuntimeError("Expected exactly one backend compute_sla function")
    module = ast.Module(
        body=[ast.ImportFrom(module="__future__", names=[ast.alias(name="annotations")], level=0), matches[0]],
        type_ignores=[],
    )
    ast.fix_missing_locations(module)
    namespace = dict(THRESHOLDS)
    namespace.update({"datetime": datetime, "timezone": timezone})
    exec(compile(module, f"{commit}:compute_sla", "exec"), namespace)
    return namespace["compute_sla"]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", default="http://160.191.47.17")
    args = parser.parse_args()

    commit = staging_commit(args.base_url)
    git("fetch", "--quiet", "origin", "main")
    try:
        git("cat-file", "-e", f"{commit}^{{commit}}")
    except RuntimeError:
        git("fetch", "--quiet", "origin", commit)
        git("cat-file", "-e", f"{commit}^{{commit}}")
    kitchen_source = source_for(commit, "backend/app/api/v1/kitchen.py")
    config_source = source_for(commit, "backend/app/core/config.py")
    verify_defaults(config_source)
    compute_sla = load_compute_sla(kitchen_source, commit)
    now = datetime(2026, 10, 14, 0, 0, tzinfo=timezone.utc)

    print(f"[DES-QA-06] PF-13 staging commit {commit[:7]}; backend compute_sla at same commit; source defaults 8/12/15 min")
    for case_id, clock, seconds, expected in CASES:
        started_at = now - timedelta(seconds=seconds)
        elapsed, actual = compute_sla("IN_PROGRESS", started_at, now)
        expected_display = round(seconds / 60, 1)
        if actual != expected or elapsed != expected_display:
            raise AssertionError(
                f"{case_id} {clock}: expected {expected}/{expected_display}, got {actual}/{elapsed}"
            )
        print(f"[DES-QA-06] PF-13 {case_id} {clock}: sla_status={actual}; elapsed_minutes={elapsed:.1f} | component PASS")

    assert compute_sla("QUEUED", None, now) == (None, "NORMAL")
    assert compute_sla("DONE", now - timedelta(minutes=20), now) == (None, "NORMAL")
    print("[DES-QA-06] PF-13 9/9 component boundaries PASS; QUEUED/DONE control checks PASS")
    print("[DES-QA-06] Staging Queue and UI boundaries NOT executed; TC-001..009 remain Not Executed")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:
        print(f"[DES-QA-06] PF-13 FAILED: {type(exc).__name__}: {exc}", file=sys.stderr)
        sys.exit(1)
