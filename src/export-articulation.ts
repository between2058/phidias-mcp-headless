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
 */

import fs from 'node:fs';
import path from 'node:path';
import { getOutputDir, trackSessionAsset } from './phidias-client.js';

const ARTICULATION_API_URL =
  process.env.ARTICULATION_API_URL ?? 'http://172.18.245.177:50271';

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
}

export interface ExportArticulationParams {
  glb_path: string;
  model_name: string;
  parts: ExportPart[];
  joints: ExportJoint[];
  format: 'usda' | 'usdz';
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

  // Expand material presets client-side (backend only speaks numeric).
  let expandedCount = 0;
  const expandedParts = params.parts.map((p) => {
    const { expanded, part } = expandPreset(p);
    if (expanded) expandedCount++;
    return part;
  });

  const articulation = {
    model_name: params.model_name,
    parts: expandedParts,
    joints: params.joints,
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
  };
}
