/**
 * scale_model — uniformly scale a GLB so its bbox matches one or more
 * real-world physical dimensions in meters.
 *
 * Trellis2 / ReconViaGen output models normalised to a unit-ish bbox (about
 * [-0.5, 0.5]), which means Isaac Sim / Omniverse / any USD-aware physics
 * consumer will treat a 1.8 m-tall fridge and a 5 cm-tall keyring as the
 * same size. This tool rescales the model uniformly (one factor on all
 * axes) so the aspect ratio that the generator produced is preserved —
 * the caller accepts whatever proportions the generator decided on and
 * only nails the overall size to reality.
 *
 * If the caller provides more than one dimension and the implied factors
 * disagree by >5 %, that means the generated GLB's proportions don't
 * match reality. The tool emits a warning but still completes (using the
 * factor from the target dimension with the largest value) so the caller
 * can decide whether to regenerate the 3D instead of silently shipping a
 * stretched-but-correct-height artifact.
 */

import fs from 'node:fs';
import path from 'node:path';
import { NodeIO, getBounds } from '@gltf-transform/core';
import { getOutputDir, trackSessionAsset } from './phidias-client.js';

export interface ScaleModelParams {
  glb_path: string;
  width_m?: number;
  height_m?: number;
  depth_m?: number;
}

export interface ScaleModelResult {
  output_path: string;
  asset_id: string;
  source: string;
  applied_factor: number;
  original_size_m: [number, number, number];
  final_size_m: [number, number, number];
  warnings: string[];
}

type AxisKey = 'width_m' | 'height_m' | 'depth_m';
const AXIS_INDEX: Record<AxisKey, 0 | 1 | 2> = {
  width_m: 0,
  height_m: 1,
  depth_m: 2,
};

export async function scaleModel(
  params: ScaleModelParams,
): Promise<ScaleModelResult> {
  if (!fs.existsSync(params.glb_path)) {
    throw new Error(`GLB file not found: ${params.glb_path}`);
  }

  // Collect provided dimensions.
  const provided: Array<{ key: AxisKey; target: number }> = [];
  for (const key of ['width_m', 'height_m', 'depth_m'] as AxisKey[]) {
    const v = params[key];
    if (v === undefined || v === null) continue;
    if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) {
      throw new Error(`${key} must be a positive finite number, got ${v}`);
    }
    provided.push({ key, target: v });
  }
  if (provided.length === 0) {
    throw new Error(
      'At least one of width_m, height_m, depth_m is required. This tool does not guess — the caller is expected to supply the real-world size based on object type (e.g. for a 1.8 m-tall fridge, pass height_m: 1.8).',
    );
  }

  const warnings: string[] = [];

  // Read the GLB and measure its current bounding box.
  const io = new NodeIO();
  const doc = await io.read(params.glb_path);
  const scenes = doc.getRoot().listScenes();
  if (scenes.length === 0) {
    throw new Error('GLB has no scenes');
  }
  const bounds = getBounds(scenes[0]);
  if (
    !bounds ||
    !bounds.min.every(Number.isFinite) ||
    !bounds.max.every(Number.isFinite)
  ) {
    throw new Error('Could not compute bounding box for GLB scene');
  }
  const originalSize: [number, number, number] = [
    bounds.max[0] - bounds.min[0],
    bounds.max[1] - bounds.min[1],
    bounds.max[2] - bounds.min[2],
  ];
  if (originalSize.some((v) => !Number.isFinite(v) || v <= 0)) {
    throw new Error(
      `GLB has an invalid bbox size: ${originalSize.join(' × ')}`,
    );
  }

  // Compute the scale factor implied by each provided dimension.
  const factors = provided.map((p) => {
    const idx = AXIS_INDEX[p.key];
    return {
      key: p.key,
      target: p.target,
      current: originalSize[idx],
      factor: p.target / originalSize[idx],
    };
  });

  let finalFactor: number;
  let chosen: (typeof factors)[number];

  if (factors.length === 1) {
    chosen = factors[0];
    finalFactor = chosen.factor;
    warnings.push(
      `scaled by ${chosen.key} only; remaining axes follow the GLB's own aspect ratio`,
    );
  } else {
    const values = factors.map((f) => f.factor);
    const minF = Math.min(...values);
    const maxF = Math.max(...values);
    const spread = (maxF - minF) / minF;
    // Pick the target with the largest real-world value as the most
    // authoritative — usually it's the "headline" dimension people quote.
    chosen = factors.reduce((best, f) => (f.target > best.target ? f : best));
    finalFactor = chosen.factor;
    if (spread > 0.05) {
      const detail = factors
        .map(
          (f) =>
            `${f.key}=${f.target} m → factor ${f.factor.toFixed(3)}`,
        )
        .join('; ');
      warnings.push(
        `aspect-ratio mismatch between your targets and the generated GLB (spread ${(spread * 100).toFixed(1)} %). ${detail}. Using the factor from ${chosen.key} (the largest target). If real proportions matter, consider regenerating the 3D with a better reference image instead of accepting this compromise.`,
      );
    }
  }

  // Bake the uniform factor into every mesh's POSITION attribute. We write
  // a fresh Float32Array back via setArray() rather than mutating in place
  // so gltf-transform's dirty tracking is unambiguous.
  let touchedAccessors = 0;
  for (const mesh of doc.getRoot().listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      const pos = prim.getAttribute('POSITION');
      if (!pos) continue;
      const src = pos.getArray();
      if (!src) continue;
      const scaled = new Float32Array(src.length);
      for (let i = 0; i < src.length; i++) scaled[i] = src[i] * finalFactor;
      pos.setArray(scaled);
      touchedAccessors++;
    }
  }
  if (touchedAccessors === 0) {
    throw new Error('GLB contains no POSITION attributes to scale');
  }
  // Scale node translations so children retain their relative placement.
  // merge_parts bakes into world coords so translations are usually zero,
  // but we still want to handle the general case correctly.
  for (const node of doc.getRoot().listNodes()) {
    const t = node.getTranslation();
    if (t[0] === 0 && t[1] === 0 && t[2] === 0) continue;
    node.setTranslation([
      t[0] * finalFactor,
      t[1] * finalFactor,
      t[2] * finalFactor,
    ]);
  }

  // Write the scaled GLB next to the rest of the session outputs.
  const baseName = path
    .basename(params.glb_path)
    .replace(/\.glb$/i, '');
  const outputPath = path.join(
    getOutputDir(),
    `scaled_${Date.now()}_${baseName}_scaled.glb`,
  );
  await io.write(outputPath, doc);

  const finalSize: [number, number, number] = [
    originalSize[0] * finalFactor,
    originalSize[1] * finalFactor,
    originalSize[2] * finalFactor,
  ];

  const assetId = `scaled_${Date.now()}`;
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
    applied_factor: finalFactor,
    original_size_m: originalSize,
    final_size_m: finalSize,
    warnings,
  };
}
