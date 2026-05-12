#!/usr/bin/env python3
"""Step1X-3D-inspired watertight conversion helper for the Phidias MCP server.

Spawned from TypeScript via subprocess. Takes an input GLB and an output path,
runs per-part SDF → marching-cubes watertight conversion, preserving node
names (`part_0`, `part_1`, ...) for downstream `export_articulation`.

JSON output schema on stdout:
{
  "ok": true,
  "input":  "/path/to/named.glb",
  "output": "/path/to/named_watertight.glb",
  "part_count":              N,
  "parts_converted":         K,
  "parts_strictly_watertight": M,
  "elapsed_ms":              ...
}

Or on error:
{ "ok": false, "error": "...", "input": "...", "output": "..." }

Run with:
  /home/pegaai/phidas/benchmark/.venv/bin/python watertight_glb.py <in.glb> <out.glb>
"""
from __future__ import annotations
import argparse
import json
import sys
import time
from pathlib import Path

# Reuse the existing implementation from the benchmark harness
sys.path.insert(0, "/home/pegaai/phidas/benchmark")
from harness.watertight import watertight_glb  # type: ignore


def main() -> int:
    ap = argparse.ArgumentParser(description="Watertight GLB (MCP helper)")
    ap.add_argument("input_glb")
    ap.add_argument("output_glb")
    ap.add_argument("--grid", type=int, default=64, help="Marching cubes grid resolution (default 64)")
    args = ap.parse_args()

    inp = Path(args.input_glb)
    outp = Path(args.output_glb)
    if not inp.exists():
        print(json.dumps({"ok": False, "error": f"input not found: {inp}",
                          "input": str(inp), "output": str(outp)}))
        return 2

    try:
        t0 = time.perf_counter()
        results = watertight_glb(inp, outp, grid_resolution=args.grid)
        elapsed_ms = int((time.perf_counter() - t0) * 1000)
    except Exception as err:
        print(json.dumps({
            "ok": False,
            "error": f"{type(err).__name__}: {err}",
            "input": str(inp),
            "output": str(outp),
        }))
        return 3

    part_count = len(results)
    converted = sum(1 for r in results if r.success)
    watertight = sum(1 for r in results if r.output_watertight)
    print(json.dumps({
        "ok": True,
        "input": str(inp),
        "output": str(outp),
        "part_count": part_count,
        "parts_converted": converted,
        "parts_strictly_watertight": watertight,
        "elapsed_ms": elapsed_ms,
    }, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
