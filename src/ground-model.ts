/**
 * ground_model — translate a GLB so its bounding-box minimum Y lands on 0,
 * i.e. "drop the asset onto the ground plane". Optionally also recenter
 * the XZ axes so the object's vertical axis passes through the world
 * origin (Isaac Sim / Omniverse convention: asset origin at the footprint
 * centre, Y=0 is the floor).
 *
 * Recommended placement in the pipeline: right after scale_model, so every
 * subsequent step (segment_model, inspect_model, export_articulation) sees
 * coordinates already in the grounded/centred frame. Joint anchors pulled
 * from inspect_model bboxes are then directly usable in the Isaac Sim
 * world without any post-hoc translation.
 *
 * This tool only ever translates — it never rotates, scales, or reflects.
 * Aspect ratio / handedness / orientation are all preserved.
 */

import fs from 'node:fs';
import path from 'node:path';
import { NodeIO, getBounds } from '@gltf-transform/core';
import { getOutputDir, trackSessionAsset } from './phidias-client.js';

export interface GroundModelParams {
  glb_path: string;
  center_xz?: boolean; // default: true
}

export interface GroundModelResult {
  output_path: string;
  asset_id: string;
  source: string;
  translation_applied: [number, number, number];
  original_bbox: {
    min: [number, number, number];
    max: [number, number, number];
  };
  final_bbox: {
    min: [number, number, number];
    max: [number, number, number];
  };
  warnings: string[];
}

export async function groundModel(
  params: GroundModelParams,
): Promise<GroundModelResult> {
  if (!fs.existsSync(params.glb_path)) {
    throw new Error(`GLB file not found: ${params.glb_path}`);
  }
  const centerXZ = params.center_xz ?? true;

  const io = new NodeIO();
  const doc = await io.read(params.glb_path);
  const scenes = doc.getRoot().listScenes();
  if (scenes.length === 0) throw new Error('GLB has no scenes');

  const bounds = getBounds(scenes[0]);
  if (
    !bounds ||
    !bounds.min.every(Number.isFinite) ||
    !bounds.max.every(Number.isFinite)
  ) {
    throw new Error('Could not compute bounding box for GLB scene');
  }

  const origMin: [number, number, number] = [
    bounds.min[0],
    bounds.min[1],
    bounds.min[2],
  ];
  const origMax: [number, number, number] = [
    bounds.max[0],
    bounds.max[1],
    bounds.max[2],
  ];

  // dy: lift so that min_y becomes 0.
  // dx, dz: if center_xz, shift so that (min+max)/2 becomes 0 on that axis.
  const dy = -origMin[1];
  const dx = centerXZ ? -(origMin[0] + origMax[0]) / 2 : 0;
  const dz = centerXZ ? -(origMin[2] + origMax[2]) / 2 : 0;

  const warnings: string[] = [];
  // If the model is already grounded / centred, report it but still produce
  // a fresh file so the caller gets a stable output path for chaining.
  const epsilon = 1e-6;
  if (Math.abs(dy) < epsilon && Math.abs(dx) < epsilon && Math.abs(dz) < epsilon) {
    warnings.push(
      'model was already grounded and centred within epsilon; wrote an identity copy',
    );
  }

  let touchedAccessors = 0;
  for (const mesh of doc.getRoot().listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      const pos = prim.getAttribute('POSITION');
      if (!pos) continue;
      const src = pos.getArray();
      if (!src) continue;
      // POSITION is xyz triples; translate each component independently.
      const shifted = new Float32Array(src.length);
      for (let i = 0; i < src.length; i += 3) {
        shifted[i] = src[i] + dx;
        shifted[i + 1] = src[i + 1] + dy;
        shifted[i + 2] = src[i + 2] + dz;
      }
      pos.setArray(shifted);
      touchedAccessors++;
    }
  }
  if (touchedAccessors === 0) {
    throw new Error('GLB contains no POSITION attributes to translate');
  }
  // Translate node translations too, so children with non-zero translations
  // land in the right world position (no-op when translations are zero).
  for (const node of doc.getRoot().listNodes()) {
    const t = node.getTranslation();
    if (t[0] === 0 && t[1] === 0 && t[2] === 0) continue;
    node.setTranslation([t[0] + dx, t[1] + dy, t[2] + dz]);
  }

  const baseName = path
    .basename(params.glb_path)
    .replace(/\.glb$/i, '');
  const outputPath = path.join(
    getOutputDir(),
    `grounded_${Date.now()}_${baseName}_grounded.glb`,
  );
  await io.write(outputPath, doc);

  const finalMin: [number, number, number] = [
    origMin[0] + dx,
    origMin[1] + dy,
    origMin[2] + dz,
  ];
  const finalMax: [number, number, number] = [
    origMax[0] + dx,
    origMax[1] + dy,
    origMax[2] + dz,
  ];

  const assetId = `grounded_${Date.now()}`;
  trackSessionAsset({
    id: assetId,
    type: 'model',
    filePath: outputPath,
    sourceImagePath: params.glb_path,
    createdAt: new Date().toISOString(),
  });

  return {
    output_path: outputPath,
    asset_id: assetId,
    source: params.glb_path,
    translation_applied: [dx, dy, dz],
    original_bbox: { min: origMin, max: origMax },
    final_bbox: { min: finalMin, max: finalMax },
    warnings,
  };
}
