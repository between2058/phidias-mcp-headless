#!/usr/bin/env python3
"""Parse a USDZ's UsdPhysics schemas into a Phidias physics-store JSON.

Usage:
    python3 scripts/usdz_to_phidias_physics.py <input.usdz> [-o output.json]

Requires `usdcat` on PATH (ships with macOS Xcode CLT).
Emits JSON matching the shape consumed by the "Import Config" button in the
Physics tab: { parts: PhysicsPart[], joints: PhysicsJoint[] }.
"""
from __future__ import annotations

import argparse
import json
import re
import subprocess
import tempfile
import zipfile
from pathlib import Path

AXIS_MAP = {"X": [1.0, 0.0, 0.0], "Y": [0.0, 1.0, 0.0], "Z": [0.0, 0.0, 1.0]}
JOINT_TYPE_MAP = {
    "PhysicsRevoluteJoint": "Revolute",
    "PhysicsPrismaticJoint": "Prismatic",
    "PhysicsFixedJoint": "Fixed",
    "PhysicsSphericalJoint": "Spherical",
}
PALETTE = [
    "#7c3aed", "#f5a623", "#2dd4bf", "#f43f5e", "#fbbf24",
    "#60a5fa", "#a78bfa", "#34d399", "#fb7185", "#fcd34d",
    "#38bdf8", "#c084fc", "#4ade80", "#f87171", "#facc15",
    "#9333ea", "#ea580c", "#0d9488", "#be123c", "#d97706",
]


def extract_usda(usdz_path: Path, workdir: Path) -> Path:
    with zipfile.ZipFile(usdz_path) as zf:
        zf.extractall(workdir)
    usdc = next(iter(list(workdir.glob("*.usdc")) + list(workdir.glob("*.usd"))), None)
    if usdc is None:
        raise SystemExit(f"No .usdc/.usd file found inside {usdz_path.name}")
    usda = workdir / "stage.usda"
    subprocess.run(
        ["usdcat", "--flatten", "--out", str(usda), str(usdc)],
        check=True,
        capture_output=True,
    )
    return usda


def _find_blocks(text: str, def_pattern: str, indent: int):
    """Yield (header_text, body_text) for each `def <def_pattern>` at exact indent.

    The header may span multiple lines (USDA writes apiSchemas on the next line
    inside parens), so we collect everything from the `def` line up to—but not
    including—the `{` that opens the block.

    Brace-depth scanning on the body ensures nested Mesh / Shader blocks don't
    prematurely terminate the parent block.
    """
    lines = text.split("\n")
    header_re = re.compile(rf'^ {{{indent}}}def {def_pattern}(?=\s|$)')
    i = 0
    while i < len(lines):
        if header_re.match(lines[i]):
            header_start = i
            j = i
            while j < len(lines) and "{" not in lines[j]:
                j += 1
            if j >= len(lines):
                break
            header = "\n".join(lines[header_start:j])
            body_lines = []
            depth = lines[j].count("{") - lines[j].count("}")
            k = j + 1
            while k < len(lines) and depth > 0:
                depth += lines[k].count("{") - lines[k].count("}")
                if depth > 0:
                    body_lines.append(lines[k])
                k += 1
            yield header, "\n".join(body_lines)
            i = k
        else:
            i += 1


def _float(body: str, key: str, default: float) -> float:
    m = re.search(rf'{re.escape(key)}\s*=\s*(-?[\d.eE+\-]+)', body)
    return float(m.group(1)) if m else default


def _str(body: str, key: str) -> str | None:
    m = re.search(rf'{re.escape(key)}\s*=\s*"([^"]+)"', body)
    return m.group(1) if m else None


def _point3(body: str, key: str, default):
    m = re.search(rf'{re.escape(key)}\s*=\s*\((-?[\d.eE+\-]+)\s*,\s*(-?[\d.eE+\-]+)\s*,\s*(-?[\d.eE+\-]+)\)', body)
    if not m:
        return default
    return [float(m.group(1)), float(m.group(2)), float(m.group(3))]


def _rel_tail(body: str, key: str) -> str | None:
    m = re.search(rf'{re.escape(key)}\s*=\s*<([^>]+)>', body)
    if not m:
        return None
    return m.group(1).rstrip("/").split("/")[-1]


def _header_name(header: str) -> str:
    m = re.search(r'"([^"]+)"', header)
    return m.group(1) if m else ""


def parse_materials(text: str) -> dict[str, dict]:
    mats: dict[str, dict] = {}
    for header, body in _find_blocks(text, r'Material "[^"]+"', indent=8):
        if "PhysicsMaterialAPI" not in header:
            continue
        name = _header_name(header)
        mats[name] = {
            "staticFriction": _float(body, "physics:staticFriction", 0.5),
            "dynamicFriction": _float(body, "physics:dynamicFriction", 0.3),
            "restitution": _float(body, "physics:restitution", 0.1),
        }
    return mats


def parse_parts(text: str, materials: dict[str, dict], base_id: str | None) -> list[dict]:
    parts: list[dict] = []
    for idx, (header, body) in enumerate(_find_blocks(text, r'Xform "[^"]+"', indent=4)):
        if "PhysicsRigidBodyAPI" not in header:
            continue
        name = _header_name(header)

        density = _float(body, "physics:density", 1000.0)
        mass_val = _float(body, "physics:mass", -1.0)
        mass = mass_val if mass_val > 0 else None

        # Find the inner Mesh block (indent=8) for collision + material binding
        collision_type = "convexHull"
        mat_name: str | None = None
        for mhdr, mbody in _find_blocks(body, r'Mesh "[^"]+"', indent=8):
            if "PhysicsCollisionAPI" in mhdr:
                approx = _str(mbody, "physics:approximation") or "convexHull"
                if approx in ("convexHull", "mesh", "convexDecomposition", "none"):
                    collision_type = approx
            binding = _rel_tail(mbody, "rel material:binding")
            if binding:
                mat_name = binding
            break

        mat = materials.get(mat_name or "", {})
        parts.append({
            "id": name,
            "name": name,
            "color": PALETTE[idx % len(PALETTE)],
            "type": "base" if name == base_id else "link",
            "role": "other",
            "mobility": "fixed",  # refined in a second pass after joints
            "mass": mass,
            "density": density,
            "collisionType": collision_type,
            "staticFriction": mat.get("staticFriction", 0.5),
            "dynamicFriction": mat.get("dynamicFriction", 0.3),
            "restitution": mat.get("restitution", 0.1),
            "materialId": None,
            "isMaterialCustom": True,
            "originalMaterial": None,
            "vertexCount": 0,
        })
    return parts


def parse_joints(text: str) -> list[dict]:
    joints: list[dict] = []
    # Joints live under def Xform "Joints" { ... } at indent=4; inner joints at indent=8
    for jtype_prim, jtype_phidias in JOINT_TYPE_MAP.items():
        pattern = rf'{jtype_prim} "[^"]+"'
        for header, body in _find_blocks(text, pattern, indent=8):
            name = _header_name(header)
            parent = _rel_tail(body, "rel physics:body0") or ""
            child = _rel_tail(body, "rel physics:body1") or ""
            axis_tok = _str(body, "uniform token physics:axis") or "X"
            axis = AXIS_MAP.get(axis_tok, [1.0, 0.0, 0.0])
            anchor = _point3(body, "point3f physics:localPos0", [0.0, 0.0, 0.0])
            lower = _float(body, "float physics:lowerLimit", float("nan"))
            upper = _float(body, "float physics:upperLimit", float("nan"))
            has_limits = not (lower != lower or upper != upper)  # NaN check
            drive_pfx = "drive:angular:physics:" if jtype_phidias == "Revolute" else "drive:linear:physics:"
            stiffness = _float(body, f"float {drive_pfx}stiffness", 0.0)
            damping = _float(body, f"float {drive_pfx}damping", 0.0)
            max_force = _float(body, f"float {drive_pfx}maxForce", 0.0)
            drive_type_tok = _str(body, f"uniform token {drive_pfx}type")
            drive_type = "position" if drive_type_tok in ("force", "acceleration") else "none"

            joints.append({
                "id": name,
                "name": name,
                "type": jtype_phidias,
                "parentPartId": parent,
                "childPartId": child,
                "axis": axis,
                "anchor": anchor,
                "limitsEnabled": has_limits,
                "limitLower": lower if has_limits else (-45.0 if jtype_phidias == "Revolute" else -0.1),
                "limitUpper": upper if has_limits else (45.0 if jtype_phidias == "Revolute" else 0.1),
                "driveStiffness": stiffness,
                "driveDamping": damping,
                "driveMaxForce": max_force,
                "driveType": drive_type,
                "disableCollision": True,
            })
    return joints


def refine_part_mobility(parts: list[dict], joints: list[dict]) -> None:
    mobility_by_child: dict[str, str] = {}
    for j in joints:
        t = j["type"]
        if t == "Revolute":
            mobility_by_child[j["childPartId"]] = "revolute"
        elif t == "Prismatic":
            mobility_by_child[j["childPartId"]] = "prismatic"
        else:
            mobility_by_child.setdefault(j["childPartId"], "fixed")
    for p in parts:
        if p["id"] in mobility_by_child:
            p["mobility"] = mobility_by_child[p["id"]]


def infer_base_id(text: str) -> str | None:
    """Pick the prim that appears most often as body0 (parent) in joints as the base."""
    counts: dict[str, int] = {}
    for m in re.finditer(r'rel physics:body0\s*=\s*<([^>]+)>', text):
        name = m.group(1).rstrip("/").split("/")[-1]
        counts[name] = counts.get(name, 0) + 1
    if not counts:
        return None
    return max(counts, key=counts.get)


def convert(usdz_path: Path) -> dict:
    with tempfile.TemporaryDirectory() as td:
        workdir = Path(td)
        usda_path = extract_usda(usdz_path, workdir)
        text = usda_path.read_text()

    base_id = infer_base_id(text)
    materials = parse_materials(text)
    parts = parse_parts(text, materials, base_id)
    joints = parse_joints(text)
    refine_part_mobility(parts, joints)
    return {
        "schema": "phidias.physics.v1",
        "source": usdz_path.name,
        "baseId": base_id,
        "parts": parts,
        "joints": joints,
    }


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("usdz", type=Path)
    ap.add_argument("-o", "--output", type=Path, default=None)
    args = ap.parse_args()

    result = convert(args.usdz)
    out = args.output or args.usdz.with_suffix(".physics.json")
    out.write_text(json.dumps(result, indent=2))
    print(f"parts: {len(result['parts'])}  joints: {len(result['joints'])}  base: {result['baseId']}")
    print(f"wrote {out}")


if __name__ == "__main__":
    main()
