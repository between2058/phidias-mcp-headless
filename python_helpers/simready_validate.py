#!/usr/bin/env python3
"""SimReady single-asset validator helper for the Phidias MCP server.

Invoked from TypeScript via subprocess. Takes a USDZ path on the command line
and emits a JSON report on stdout. Designed for the MCP `run_aif_validate` tool.

JSON output schema:
{
  "ok": true,
  "asset": "/path/to/file.usdz",
  "pass":           true,        // zero FAILURE-severity issues
  "essential_clean": true,       // zero essential-tag failures
  "total_issues":   0,
  "failure_count":  0,
  "warning_count":  0,
  "essential_failure_count": 0,
  "unique_rules_failed":     0,
  "rule_failure_counts":     {"VG.007": 9, ...},  // empty when clean
  "validator_version":        "omniverse-asset-validator <ver>",
  "validate_time_ms":         173
}

On error:
{
  "ok": false,
  "error": "...",
  "asset": "...",
}

Equivalent to `aif-pipeline validate <usdz>` because both wrap the same
omniverse-asset-validator library.

Run with the Phidias benchmark venv:
  /home/pegaai/phidas/benchmark/.venv/bin/python simready_validate.py <usdz>
"""
from __future__ import annotations
import argparse
import json
import logging
import sys
import time
from collections import Counter
from pathlib import Path


def main() -> int:
    ap = argparse.ArgumentParser(description="SimReady validator (MCP helper)")
    ap.add_argument("usdz", help="Path to USDZ to validate")
    ap.add_argument("--verbose", action="store_true", help="Print validator INFO logs to stderr")
    args = ap.parse_args()

    if not args.verbose:
        logging.disable(logging.WARNING)

    asset = Path(args.usdz)
    if not asset.exists():
        print(json.dumps({"ok": False, "error": f"file not found: {asset}", "asset": str(asset)}))
        return 2

    try:
        from omni.asset_validator import ValidationEngine
    except ImportError as err:
        print(json.dumps({
            "ok": False,
            "error": f"omniverse-asset-validator not installed: {err}",
            "asset": str(asset),
        }))
        return 3

    try:
        engine = ValidationEngine()
        t0 = time.perf_counter()
        result = engine.validate(str(asset))
        elapsed_ms = int((time.perf_counter() - t0) * 1000)
    except Exception as err:
        print(json.dumps({
            "ok": False,
            "error": f"validator raised: {type(err).__name__}: {err}",
            "asset": str(asset),
        }))
        return 4

    failure_count = 0
    warning_count = 0
    essential_failure_count = 0
    rule_counts: Counter = Counter()
    for issue in result.issues:
        sev = issue.severity.name if hasattr(issue.severity, "name") else str(issue.severity)
        req = getattr(issue, "requirement", None)
        code = getattr(req, "code", "?")
        tags = tuple(getattr(req, "tags", ()))
        rule_counts[code] += 1
        if sev == "FAILURE":
            failure_count += 1
            if "essential" in tags:
                essential_failure_count += 1
        elif sev == "WARNING":
            warning_count += 1

    try:
        from importlib.metadata import version as _ver
        validator_version = _ver("omniverse-asset-validator")
    except Exception:
        validator_version = "unknown"

    out = {
        "ok": True,
        "asset": str(asset),
        "pass": failure_count == 0,
        "essential_clean": essential_failure_count == 0,
        "total_issues": len(result.issues),
        "failure_count": failure_count,
        "warning_count": warning_count,
        "essential_failure_count": essential_failure_count,
        "unique_rules_failed": len(rule_counts),
        "rule_failure_counts": dict(rule_counts),
        "validator_version": f"omniverse-asset-validator {validator_version}",
        "validate_time_ms": elapsed_ms,
    }
    print(json.dumps(out, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
