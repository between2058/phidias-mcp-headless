/**
 * export_articulation — send parts + joints description to the Phidias
 * articulation-service (FastAPI at ARTICULATION_API_URL) and download the
 * resulting USDA / USDZ file.
 *
 * The backend does NOT know about material presets (steel / wood / rubber
 * etc.) — it only accepts explicit numeric fields. Preset handling is done
 * entirely client-side here: if a part specifies `material_preset`, its
 * density / friction / restitution values are filled from MATERIAL_PRESETS,
 * but any explicit numeric override the caller provides wins.
 *
 * When emit_physics_json is true, an extra phidias.physics.v1 JSON is written
 * alongside the USD file. Parsing the stage is done in-process by
 * parseUsdaToPhysics() against the articulation-service's text USDA output —
 * no python / usdcat / OpenUSD tooling is required on the host.
 */

import fs from 'node:fs';
import path from 'node:path';
import { NodeIO, getBounds } from '@gltf-transform/core';
import { getOutputDir, trackSessionAsset } from './phidias-client.js';
import { parseUsdaToPhysics } from './usda-to-physics-json.js';

const ARTICULATION_API_URL =
  process.env.ARTICULATION_API_URL ?? 'http://172.18.245.177:52071';

// ---------------------------------------------------------------------------
// Material presets — client-side expansion
// ---------------------------------------------------------------------------

export const MATERIAL_PRESET_KEYS = [
  'steel',
  'aluminum',
  'rubber',
  'plastic',
  'wood',
  'concrete',
  'glass',
  'foam',
  'ice',
  'ceramic',
] as const;

export type MaterialPresetKey = (typeof MATERIAL_PRESET_KEYS)[number];

interface PresetValues {
  density: number;
  static_friction: number;
  dynamic_friction: number;
  restitution: number;
}

export const MATERIAL_PRESETS: Record<MaterialPresetKey, PresetValues> = {
  steel:    { density: 7850, static_friction: 0.6, dynamic_friction: 0.5,  restitution: 0.1 },
  aluminum: { density: 2700, static_friction: 0.4, dynamic_friction: 0.3,  restitution: 0.1 },
  rubber:   { density: 1100, static_friction: 0.9, dynamic_friction: 0.8,  restitution: 0.7 },
  plastic:  { density: 1200, static_friction: 0.4, dynamic_friction: 0.3,  restitution: 0.3 },
  wood:     { density:  700, static_friction: 0.5, dynamic_friction: 0.4,  restitution: 0.2 },
  concrete: { density: 2400, static_friction: 0.7, dynamic_friction: 0.6,  restitution: 0.05 },
  glass:    { density: 2500, static_friction: 0.3, dynamic_friction: 0.2,  restitution: 0.2 },
  foam:     { density:   50, static_friction: 0.6, dynamic_friction: 0.5,  restitution: 0.1 },
  ice:      { density:  917, static_friction: 0.1, dynamic_friction: 0.03, restitution: 0.05 },
  ceramic:  { density: 2400, static_friction: 0.6, dynamic_friction: 0.5,  restitution: 0.1 },
};

// ---------------------------------------------------------------------------
// Request / result types
// ---------------------------------------------------------------------------

export interface ExportPart {
  id: string;
  name: string;
  type?: 'link' | 'base' | 'tool' | 'joint';
  role?: 'actuator' | 'support' | 'gripper' | 'sensor' | 'other';
  mobility?: 'fixed' | 'revolute' | 'prismatic';
  mass?: number | null;
  density?: number;
  center_of_mass?: [number, number, number] | null;
  collision_type?: 'mesh' | 'convexHull' | 'convexDecomposition' | 'none';
  static_friction?: number;
  dynamic_friction?: number;
  restitution?: number;
  material_preset?: MaterialPresetKey;
}

export interface ExportJoint {
  name: string;
  parent: string;
  child: string;
  type?: 'fixed' | 'revolute' | 'prismatic';
  axis?: [number, number, number];
  anchor?: [number, number, number];
  lower_limit?: number | null;
  upper_limit?: number | null;
  drive_stiffness?: number | null;
  drive_damping?: number | null;
  drive_max_force?: number | null;
  drive_type?: 'position' | 'velocity' | 'none';
  disable_collision?: boolean;
  // When true (the default), MCP checks the joint's geometry and flips
  // limit signs if positive motion goes INTO the parent bulk, so
  // "positive = opens outward" holds regardless of which axis of the GLB
  // happens to be the model's front. Set false to keep the exact signs
  // you provided (e.g. when you deliberately want backward-swinging motion).
  auto_orient_limits?: boolean;
}

export interface ExportArticulationParams {
  glb_path: string;
  model_name: string;
  parts: ExportPart[];
  joints: ExportJoint[];
  format: 'usda' | 'usdz';
  emit_physics_json?: boolean;
}

export interface ExportArticulationResult {
  output_path: string;
  backend_filename: string;
  parts_count: number;
  joints_count: number;
  presets_expanded: number;
  asset_id: string;
  source: string;
  format: 'usda' | 'usdz';
  warnings: string[];
  physics_json_path?: string;
  physics_json_asset_id?: string;
}

// ---------------------------------------------------------------------------
// Preset expansion
// ---------------------------------------------------------------------------

function expandPreset(p: ExportPart): {
  expanded: boolean;
  part: Omit<ExportPart, 'material_preset'>;
} {
  if (!p.material_preset) {
    const { material_preset: _unused, ...rest } = p;
    return { expanded: false, part: rest };
  }
  const preset = MATERIAL_PRESETS[p.material_preset];
  if (!preset) {
    const { material_preset: _unused, ...rest } = p;
    return { expanded: false, part: rest };
  }

  // Explicit values win over preset defaults. Callers can mix — e.g.
  // `material_preset: "steel", mass: 3.2` uses steel's density/friction but
  // sets mass explicitly instead of letting the backend auto-compute.
  const presetFields: Partial<ExportPart> = {
    density: p.density ?? preset.density,
    static_friction: p.static_friction ?? preset.static_friction,
    dynamic_friction: p.dynamic_friction ?? preset.dynamic_friction,
    restitution: p.restitution ?? preset.restitution,
  };
  const { material_preset: _unused, ...rest } = p;
  return {
    expanded: true,
    part: { ...rest, ...presetFields },
  };
}

// ---------------------------------------------------------------------------
// Pre-flight GLB read
// ---------------------------------------------------------------------------

// One pass over the GLB gives us everything we need for pre-flight work:
//   • whether each named node directly carries a mesh (validation)
//   • world-space bbox + centroid of each meshed node (joint-direction
//     analysis, so we can auto-orient limit signs so "positive = opens
//     outward" regardless of the model's front-facing axis)
interface PartGeometry {
  name: string;
  hasMesh: boolean;
  worldCentroid: [number, number, number] | null;
}

async function readPartGeometries(
  glbPath: string,
): Promise<Map<string, PartGeometry>> {
  const io = new NodeIO();
  const doc = await io.read(glbPath);
  const out = new Map<string, PartGeometry>();
  for (const node of doc.getRoot().listNodes()) {
    const name = node.getName();
    if (!name) continue;
    const hasMesh = Boolean(node.getMesh());
    let worldCentroid: [number, number, number] | null = null;
    if (hasMesh) {
      try {
        const b = getBounds(node);
        if (
          b &&
          b.min.every((v) => Number.isFinite(v)) &&
          b.max.every((v) => Number.isFinite(v))
        ) {
          worldCentroid = [
            (b.min[0] + b.max[0]) / 2,
            (b.min[1] + b.max[1]) / 2,
            (b.min[2] + b.max[2]) / 2,
          ];
        }
      } catch {
        // leave centroid null if gltf-transform can't resolve bounds
      }
    }
    // If the same name appears twice, prefer the mesh-bearing entry.
    const prior = out.get(name);
    if (!prior || (!prior.hasMesh && hasMesh)) {
      out.set(name, { name, hasMesh, worldCentroid });
    }
  }
  return out;
}

// Each part.id in the articulation call must resolve to a GLB node that
// *directly* carries a mesh. An empty group node (e.g. one produced by
// apply_part_names' `groups:` reparenting without merge) would be written as
// an Xform with no Mesh child and silently dropped by the physics JSON
// pipeline. Catch it here and redirect the caller to `merge_parts`.
function validatePartsHaveMesh(
  geometries: Map<string, PartGeometry>,
  partIds: string[],
): { missing: string[]; noMesh: string[] } {
  const missing: string[] = [];
  const noMesh: string[] = [];
  for (const id of partIds) {
    const g = geometries.get(id);
    if (!g) missing.push(id);
    else if (!g.hasMesh) noMesh.push(id);
  }
  return { missing, noMesh };
}

// ---------------------------------------------------------------------------
// Joint direction analysis (auto-orient limit signs)
// ---------------------------------------------------------------------------

type Vec3 = [number, number, number];

function vSub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}
function vLen(a: Vec3): number {
  return Math.sqrt(a[0] * a[0] + a[1] * a[1] + a[2] * a[2]);
}
function vNorm(a: Vec3): Vec3 | null {
  const l = vLen(a);
  if (l < 1e-9) return null;
  return [a[0] / l, a[1] / l, a[2] / l];
}
function vDot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}
function vCross(a: Vec3, b: Vec3): Vec3 {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

// Decide whether positive motion along this joint moves the child AWAY from
// the parent bulk ("opens outward"). Returns null when the geometry is
// degenerate / inconclusive — caller should not flip in that case.
function analyzeJointDirection(opts: {
  jointType: 'revolute' | 'prismatic' | 'fixed';
  axis: Vec3;
  anchor: Vec3;
  childCentroid: Vec3;
  parentCentroid: Vec3;
}): { positiveOpensOutward: boolean; confidence: number } | null {
  const { jointType, axis, anchor, childCentroid, parentCentroid } = opts;
  if (jointType === 'fixed') return null;

  const outwardN = vNorm(vSub(childCentroid, parentCentroid));
  const axisN = vNorm(axis);
  if (!outwardN || !axisN) return null;

  let tangentN: Vec3 | null;
  if (jointType === 'prismatic') {
    // Displacement along `axis` by +d moves child by +d * axisN.
    tangentN = axisN;
  } else {
    // Revolute: at θ=0 the velocity of the child centroid is axis × r,
    // where r = childCentroid − anchor.
    const r = vSub(childCentroid, anchor);
    tangentN = vNorm(vCross(axisN, r));
    if (!tangentN) return null; // child sits on the rotation axis
  }

  const cosTheta = vDot(tangentN, outwardN);
  return {
    positiveOpensOutward: cosTheta > 0,
    confidence: Math.abs(cosTheta),
  };
}

// Flip a single joint's limits so `positive ≡ opens outward` becomes true.
// Returns the new joint plus a human description of what changed; caller
// writes this into warnings so the user sees every auto-orient decision.
function reorientJointLimits(
  joint: ExportJoint,
  analysis: { positiveOpensOutward: boolean; confidence: number },
): { joint: ExportJoint; flipped: boolean; reason: string } {
  // Confidence threshold: if the tangent is nearly perpendicular to the
  // outward direction, the sign is ambiguous, so leave the user's limits
  // alone rather than risk a wrong flip.
  if (analysis.confidence < 0.2) {
    return {
      joint,
      flipped: false,
      reason: `auto-orient skipped (ambiguous: |cosθ|=${analysis.confidence.toFixed(2)})`,
    };
  }
  if (analysis.positiveOpensOutward) {
    return { joint, flipped: false, reason: 'auto-orient: positive already opens outward' };
  }
  const lo = joint.lower_limit;
  const hi = joint.upper_limit;
  const newLower = typeof hi === 'number' ? -hi : hi ?? null;
  const newUpper = typeof lo === 'number' ? -lo : lo ?? null;
  return {
    joint: { ...joint, lower_limit: newLower, upper_limit: newUpper },
    flipped: true,
    reason: `auto-oriented: positive rotation moved child INTO parent bulk; flipped [${lo}, ${hi}] → [${newLower}, ${newUpper}]`,
  };
}

// ---------------------------------------------------------------------------
// Physics JSON ID re-map
// ---------------------------------------------------------------------------

// The backend derives USDZ prim names from each part's `name` field
// (spaces → underscores, other non-identifier chars → underscores). Our
// USDA parser reads those sanitized prim names, so the resulting JSON
// `id` values no longer match the GLB node names — the frontend's
// MotionPreviewController binds joints to meshes via
// scene.getObjectByName(part.id), so we mutate the JSON back to the
// caller-supplied ids (and original names).
function sanitizeUsdPrim(s: string): string {
  let r = s.replace(/[^A-Za-z0-9_]/g, '_');
  if (/^[0-9]/.test(r)) r = '_' + r;
  return r;
}

interface MutablePhysicsJson {
  baseId?: string | null;
  parts?: Array<{ id?: string; name?: string }>;
  joints?: Array<{ parentPartId?: string; childPartId?: string }>;
}

function remapPhysicsJsonIds(
  json: MutablePhysicsJson,
  parts: ExportPart[],
): void {
  // Build sanitized-prim → original-id / original-name lookup.
  const idByPrim = new Map<string, string>();
  const nameByPrim = new Map<string, string>();
  for (const p of parts) {
    for (const key of [p.name, p.id]) {
      if (!key) continue;
      const prim = sanitizeUsdPrim(key);
      if (!idByPrim.has(prim)) idByPrim.set(prim, p.id);
      if (!nameByPrim.has(prim)) nameByPrim.set(prim, p.name);
    }
  }

  const remap = (v: unknown): string | undefined => {
    if (typeof v !== 'string') return undefined;
    return idByPrim.get(v);
  };

  if (typeof json.baseId === 'string') {
    const r = remap(json.baseId);
    if (r) json.baseId = r;
  }
  if (Array.isArray(json.parts)) {
    for (const p of json.parts) {
      if (typeof p.id === 'string') {
        const r = remap(p.id);
        if (r) {
          p.id = r;
          const nm = nameByPrim.get(sanitizeUsdPrim(r)) ?? nameByPrim.get(p.id);
          if (nm) p.name = nm;
        }
      }
    }
  }
  if (Array.isArray(json.joints)) {
    for (const j of json.joints) {
      if (typeof j.parentPartId === 'string') {
        const r = remap(j.parentPartId);
        if (r) j.parentPartId = r;
      }
      if (typeof j.childPartId === 'string') {
        const r = remap(j.childPartId);
        if (r) j.childPartId = r;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------

export async function exportArticulation(
  params: ExportArticulationParams,
): Promise<ExportArticulationResult> {
  if (!fs.existsSync(params.glb_path)) {
    throw new Error(`GLB file not found: ${params.glb_path}`);
  }
  if (!Array.isArray(params.parts) || params.parts.length === 0) {
    throw new Error('parts array must not be empty');
  }
  if (!params.model_name || typeof params.model_name !== 'string') {
    throw new Error('model_name is required and must be a non-empty string');
  }

  const warnings: string[] = [];

  // One pass over the GLB gives us per-part mesh-presence + centroid,
  // used for both pre-flight validation and joint-direction auto-orient.
  const geometries = await readPartGeometries(params.glb_path);

  // Pre-flight: every part.id must resolve to a GLB node with a real mesh.
  // An empty group node (leftover from apply_part_names groups:) would
  // vanish in the physics JSON and produce a broken articulation.
  const meshCheck = validatePartsHaveMesh(
    geometries,
    params.parts.map((p) => p.id),
  );
  if (meshCheck.missing.length > 0 || meshCheck.noMesh.length > 0) {
    const msgs: string[] = [];
    if (meshCheck.missing.length > 0) {
      msgs.push(
        `parts[].id not found as a node name in the GLB: ${meshCheck.missing.join(', ')}`,
      );
    }
    if (meshCheck.noMesh.length > 0) {
      msgs.push(
        `parts[].id references a node with no direct mesh — likely an empty group from apply_part_names. Fuse its children into a real mesh with merge_parts first: ${meshCheck.noMesh.join(', ')}`,
      );
    }
    throw new Error(msgs.join(' | '));
  }

  // Validate joint references against part IDs up-front — the backend silently
  // ignores orphan joints, so catching them here gives a much better error.
  const partIds = new Set(params.parts.map((p) => p.id));
  for (const j of params.joints) {
    if (!partIds.has(j.parent)) {
      warnings.push(
        `joint "${j.name}": parent id "${j.parent}" not found among parts`,
      );
    }
    if (!partIds.has(j.child)) {
      warnings.push(
        `joint "${j.name}": child id "${j.child}" not found among parts`,
      );
    }
  }

  // Auto-orient each joint's limit signs so "positive = opens outward" holds
  // regardless of which GLB axis happens to be the front of the model.
  const orientedJoints = params.joints.map((j) => {
    if (j.auto_orient_limits === false) return j;
    const type = j.type ?? 'revolute';
    if (type === 'fixed') return j;
    const childG = geometries.get(j.child);
    const parentG = geometries.get(j.parent);
    if (!childG?.worldCentroid || !parentG?.worldCentroid) return j;
    const analysis = analyzeJointDirection({
      jointType: type,
      axis: j.axis ?? [0, 0, 1],
      anchor: j.anchor ?? [0, 0, 0],
      childCentroid: childG.worldCentroid,
      parentCentroid: parentG.worldCentroid,
    });
    if (!analysis) return j;
    const { joint: nextJoint, flipped, reason } = reorientJointLimits(j, analysis);
    if (flipped) warnings.push(`joint "${j.name}": ${reason}`);
    return nextJoint;
  });

  // Expand material presets client-side (backend only speaks numeric).
  let expandedCount = 0;
  const expandedParts = params.parts.map((p) => {
    const { expanded, part } = expandPreset(p);
    if (expanded) expandedCount++;
    return part;
  });

  // Strip client-only fields (auto_orient_limits) before sending to backend.
  const backendJoints = orientedJoints.map(({ auto_orient_limits, ...rest }) => {
    void auto_orient_limits;
    return rest;
  });
  const articulation = {
    model_name: params.model_name,
    parts: expandedParts,
    joints: backendJoints,
  };

  // Upload GLB + articulation JSON as multipart/form-data.
  const glbBuffer = fs.readFileSync(params.glb_path);
  const glbBlob = new Blob([glbBuffer], { type: 'model/gltf-binary' });
  const formData = new FormData();
  formData.append('file', glbBlob, path.basename(params.glb_path));
  formData.append('articulation', JSON.stringify(articulation));

  const endpoint = params.format === 'usdz' ? 'export-usdz' : 'export-usda';
  const postUrl = `${ARTICULATION_API_URL}/api/${endpoint}`;

  const res = await fetch(postUrl, { method: 'POST', body: formData });
  if (!res.ok) {
    let detail: string;
    try {
      const j = (await res.json()) as { detail?: unknown };
      detail =
        typeof j.detail === 'string' ? j.detail : JSON.stringify(j.detail ?? j);
    } catch {
      detail = await res.text().catch(() => res.statusText);
    }
    throw new Error(`Articulation export failed (${res.status}): ${detail}`);
  }

  const data = (await res.json()) as {
    success: boolean;
    message?: string;
    filename: string;
    download_url: string;
    format: string;
  };
  if (!data.success) {
    throw new Error(
      `Articulation export returned success=false: ${JSON.stringify(data)}`,
    );
  }

  // Fetch the produced USD file and persist it locally so download_asset /
  // list_generated_assets can hand it back to the caller.
  const dlUrl = data.download_url.startsWith('http')
    ? data.download_url
    : `${ARTICULATION_API_URL}${data.download_url}`;
  const dlRes = await fetch(dlUrl);
  if (!dlRes.ok) {
    throw new Error(
      `Articulation download failed (${dlRes.status}) from ${dlUrl}`,
    );
  }
  const fileBuffer = Buffer.from(await dlRes.arrayBuffer());

  const outputPath = path.join(
    getOutputDir(),
    `articulation_${Date.now()}_${data.filename}`,
  );
  fs.writeFileSync(outputPath, fileBuffer);

  const assetId = `articulation_${Date.now()}`;
  trackSessionAsset({
    id: assetId,
    type: 'model',
    filePath: outputPath,
    sourceImagePath: params.glb_path,
    createdAt: new Date().toISOString(),
  });

  // Post-step: produce a phidias.physics.v1 JSON for the frontend Physics
  // Editor's "Import Config" button. The parser needs the stage as text USDA;
  // when the caller asked for USDA we already have the right file on disk,
  // otherwise we fire a second articulation-service call for USDA text. Failures
  // here do not fail the whole export — the USD file is already a valid artifact.
  let physicsJsonPath: string | undefined;
  let physicsJsonAssetId: string | undefined;
  const emitJson = params.emit_physics_json ?? (params.format === 'usdz');
  if (emitJson) {
    try {
      let usdaText: string;
      if (params.format === 'usda') {
        usdaText = fs.readFileSync(outputPath, 'utf-8');
      } else {
        // Second backend call just to get the text stage. The GLB + articulation
        // description are identical, so only the endpoint changes.
        const usdaForm = new FormData();
        usdaForm.append('file', glbBlob, path.basename(params.glb_path));
        usdaForm.append('articulation', JSON.stringify(articulation));
        const usdaRes = await fetch(
          `${ARTICULATION_API_URL}/api/export-usda`,
          { method: 'POST', body: usdaForm },
        );
        if (!usdaRes.ok) {
          throw new Error(
            `export-usda request failed (${usdaRes.status})`,
          );
        }
        const usdaMeta = (await usdaRes.json()) as {
          success: boolean;
          download_url: string;
        };
        if (!usdaMeta.success) {
          throw new Error('export-usda returned success=false');
        }
        const usdaDlUrl = usdaMeta.download_url.startsWith('http')
          ? usdaMeta.download_url
          : `${ARTICULATION_API_URL}${usdaMeta.download_url}`;
        const usdaDl = await fetch(usdaDlUrl);
        if (!usdaDl.ok) {
          throw new Error(
            `USDA download failed (${usdaDl.status}) from ${usdaDlUrl}`,
          );
        }
        usdaText = await usdaDl.text();
      }

      const physicsJson = parseUsdaToPhysics(usdaText, data.filename);
      remapPhysicsJsonIds(physicsJson, params.parts);

      const jsonOut = outputPath.replace(/\.usdz?$/i, '.physics.json');
      fs.writeFileSync(jsonOut, JSON.stringify(physicsJson, null, 2));
      physicsJsonPath = jsonOut;
      physicsJsonAssetId = `physics_${Date.now()}`;
      trackSessionAsset({
        id: physicsJsonAssetId,
        type: 'model',
        filePath: jsonOut,
        sourceImagePath: outputPath,
        createdAt: new Date().toISOString(),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      warnings.push(`physics JSON generation failed: ${msg}`);
    }
  }

  return {
    output_path: outputPath,
    backend_filename: data.filename,
    parts_count: params.parts.length,
    joints_count: params.joints.length,
    presets_expanded: expandedCount,
    asset_id: assetId,
    source: params.glb_path,
    format: params.format,
    warnings,
    physics_json_path: physicsJsonPath,
    physics_json_asset_id: physicsJsonAssetId,
  };
}
