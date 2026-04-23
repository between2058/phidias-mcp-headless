/**
 * merge_parts — geometry-level mesh merge for over-segmented GLBs.
 *
 * Each merge spec fuses a set of member nodes into a single new Node whose
 * Mesh contains the combined geometry in world space. Members' original Nodes
 * and Meshes are removed from the scene graph; orphan accessors/materials are
 * pruned. The source file is never modified — a new GLB is written and tracked
 * as a session asset.
 *
 * Design decisions:
 *   - Node indices match inspect_model's order (root.listNodes()).
 *   - Multi-material merges stay valid: primitives are grouped by material so
 *     one merged Node can carry several primitives, one per material.
 *   - New Node has identity transform; vertex data is stored in world space.
 *   - A node may appear in at most one merge per call.
 *   - Members must have a Mesh; members without geometry are skipped with a
 *     warning.
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  NodeIO,
  Document,
  type Node as GLTFNode,
  type Scene,
  type Primitive,
  type Material,
  Accessor,
} from '@gltf-transform/core';
import { prune } from '@gltf-transform/functions';
import { mat3, mat4, vec3 } from 'gl-matrix';
import { getOutputDir, trackSessionAsset } from './phidias-client.js';

export interface MergeSpec {
  name: string;
  member_indices: number[];
}

export interface MergePartsParams {
  glb_path: string;
  merges: MergeSpec[];
}

export interface MergePartsResult {
  output_path: string;
  applied_merges: number;
  removed_nodes: number;
  removed_meshes: number;
  warnings: string[];
  source: string;
  asset_id: string;
}

// ---------------------------------------------------------------------------
// World transform helpers
// ---------------------------------------------------------------------------

function composeLocalMatrix(node: GLTFNode): mat4 {
  const m = mat4.create();
  const t = node.getTranslation();
  const r = node.getRotation();
  const s = node.getScale();
  mat4.fromRotationTranslationScale(m, r as any, t as any, s as any);
  return m;
}

function getWorldMatrix(node: GLTFNode, parentOf: Map<GLTFNode, GLTFNode | null>): mat4 {
  // Walk up to root, collecting local matrices, then multiply from root down.
  const chain: GLTFNode[] = [];
  let current: GLTFNode | null = node;
  while (current) {
    chain.push(current);
    current = parentOf.get(current) ?? null;
  }
  chain.reverse();
  const world = mat4.create();
  for (const n of chain) {
    const local = composeLocalMatrix(n);
    mat4.multiply(world, world, local);
  }
  return world;
}

// ---------------------------------------------------------------------------
// Geometry merge — turns a set of {primitive, world matrix} into one primitive
// ---------------------------------------------------------------------------

const ACCESSOR_TYPE_BY_SIZE: Record<number, GLTFAccessorType> = {
  1: 'SCALAR',
  2: 'VEC2',
  3: 'VEC3',
  4: 'VEC4',
};

type GLTFAccessorType = 'SCALAR' | 'VEC2' | 'VEC3' | 'VEC4';

interface PrimItem {
  prim: Primitive;
  worldMatrix: mat4;
}

function intersectionOfSemantics(items: PrimItem[]): string[] {
  const first = new Set(items[0].prim.listSemantics());
  for (let i = 1; i < items.length; i++) {
    const here = new Set(items[i].prim.listSemantics());
    for (const s of first) {
      if (!here.has(s)) first.delete(s);
    }
  }
  return [...first];
}

function mergePrimitivesForMaterial(
  doc: Document,
  items: PrimItem[],
  droppedAttrs: Set<string>,
): Primitive {
  // Intersect attribute semantics: if one member is missing NORMAL, we drop
  // NORMAL from the result rather than emitting garbage. The caller collects
  // names of dropped attrs so we can warn once per call.
  const semantics = intersectionOfSemantics(items);
  for (const sem of items[0].prim.listSemantics()) {
    if (!semantics.includes(sem)) droppedAttrs.add(sem);
  }

  let totalVerts = 0;
  let totalIndices = 0;
  for (const { prim } of items) {
    const pos = prim.getAttribute('POSITION');
    if (!pos) continue;
    const count = pos.getCount();
    totalVerts += count;
    const idx = prim.getIndices();
    totalIndices += idx ? idx.getCount() : count;
  }

  const elementSizes: Record<string, number> = {};
  const outBuffers: Record<string, Float32Array> = {};
  for (const sem of semantics) {
    const size = items[0].prim.getAttribute(sem)!.getElementSize();
    elementSizes[sem] = size;
    outBuffers[sem] = new Float32Array(totalVerts * size);
  }

  // Choose index type to cover totalVerts.
  const outIndices =
    totalVerts <= 0xffff ? new Uint16Array(totalIndices) : new Uint32Array(totalIndices);

  let vOff = 0;
  let iOff = 0;
  const tmpVec3 = vec3.create();
  const normalMatrix = mat3.create();

  for (const { prim, worldMatrix } of items) {
    const pos = prim.getAttribute('POSITION')!;
    const count = pos.getCount();

    mat3.normalFromMat4(normalMatrix, worldMatrix);

    for (const sem of semantics) {
      const acc = prim.getAttribute(sem)!;
      const size = elementSizes[sem];
      const src = acc.getArray();
      const out = outBuffers[sem];
      if (!src) continue;

      if (sem === 'POSITION') {
        for (let i = 0; i < count; i++) {
          vec3.set(tmpVec3, src[i * 3], src[i * 3 + 1], src[i * 3 + 2]);
          vec3.transformMat4(tmpVec3, tmpVec3, worldMatrix);
          out[(vOff + i) * 3] = tmpVec3[0];
          out[(vOff + i) * 3 + 1] = tmpVec3[1];
          out[(vOff + i) * 3 + 2] = tmpVec3[2];
        }
      } else if (sem === 'NORMAL') {
        for (let i = 0; i < count; i++) {
          vec3.set(tmpVec3, src[i * 3], src[i * 3 + 1], src[i * 3 + 2]);
          vec3.transformMat3(tmpVec3, tmpVec3, normalMatrix);
          const len = Math.hypot(tmpVec3[0], tmpVec3[1], tmpVec3[2]);
          if (len > 0) {
            tmpVec3[0] /= len;
            tmpVec3[1] /= len;
            tmpVec3[2] /= len;
          }
          out[(vOff + i) * 3] = tmpVec3[0];
          out[(vOff + i) * 3 + 1] = tmpVec3[1];
          out[(vOff + i) * 3 + 2] = tmpVec3[2];
        }
      } else if (sem === 'TANGENT' && size === 4) {
        // TANGENT is vec4 (xyz direction + w handedness).
        for (let i = 0; i < count; i++) {
          vec3.set(tmpVec3, src[i * 4], src[i * 4 + 1], src[i * 4 + 2]);
          vec3.transformMat3(tmpVec3, tmpVec3, normalMatrix);
          const len = Math.hypot(tmpVec3[0], tmpVec3[1], tmpVec3[2]);
          if (len > 0) {
            tmpVec3[0] /= len;
            tmpVec3[1] /= len;
            tmpVec3[2] /= len;
          }
          out[(vOff + i) * 4] = tmpVec3[0];
          out[(vOff + i) * 4 + 1] = tmpVec3[1];
          out[(vOff + i) * 4 + 2] = tmpVec3[2];
          out[(vOff + i) * 4 + 3] = src[i * 4 + 3];
        }
      } else {
        // UVs, colors, joints, weights, custom — copy as-is.
        for (let i = 0; i < count * size; i++) {
          out[vOff * size + i] = src[i];
        }
      }
    }

    const indices = prim.getIndices();
    if (indices) {
      const idxSrc = indices.getArray();
      if (idxSrc) {
        for (let i = 0; i < idxSrc.length; i++) {
          outIndices[iOff + i] = idxSrc[i] + vOff;
        }
        iOff += idxSrc.length;
      }
    } else {
      for (let i = 0; i < count; i++) {
        outIndices[iOff + i] = vOff + i;
      }
      iOff += count;
    }

    vOff += count;
  }

  const mergedPrim = doc.createPrimitive();
  for (const sem of semantics) {
    const type = ACCESSOR_TYPE_BY_SIZE[elementSizes[sem]];
    const acc = doc
      .createAccessor()
      .setType(type as any)
      .setArray(outBuffers[sem] as any);
    mergedPrim.setAttribute(sem, acc);
  }
  const idxAcc = doc
    .createAccessor()
    .setType('SCALAR' as any)
    .setArray(outIndices as any);
  mergedPrim.setIndices(idxAcc);

  return mergedPrim;
}

// ---------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------

export async function mergeParts(params: MergePartsParams): Promise<MergePartsResult> {
  if (!fs.existsSync(params.glb_path)) {
    throw new Error(`GLB file not found: ${params.glb_path}`);
  }
  if (!Array.isArray(params.merges) || params.merges.length === 0) {
    throw new Error('merges must be a non-empty array');
  }

  const io = new NodeIO();
  const doc = await io.read(params.glb_path);
  const root = doc.getRoot();
  const allNodes = root.listNodes();
  const scenes = root.listScenes();
  if (scenes.length === 0) throw new Error('GLB has no scene');
  const scene = scenes[0];

  const warnings: string[] = [];
  const byIndex = new Map<number, GLTFNode>();
  allNodes.forEach((n, i) => byIndex.set(i, n));

  // Snapshot parents at read time. Two maps:
  //  - nodeOrSceneParent: can be Scene, used for attachment + child removal.
  //  - nodeParentOnly: Node-only, used for world-matrix chain computation.
  const nodeOrSceneParent = new Map<GLTFNode, GLTFNode | Scene | null>();
  const nodeParentOnly = new Map<GLTFNode, GLTFNode | null>();
  for (const n of allNodes) {
    nodeOrSceneParent.set(n, null);
    nodeParentOnly.set(n, null);
  }
  for (const s of scenes) {
    for (const child of s.listChildren()) nodeOrSceneParent.set(child, s);
  }
  for (const p of allNodes) {
    for (const child of p.listChildren()) {
      nodeOrSceneParent.set(child, p);
      nodeParentOnly.set(child, p);
    }
  }

  const alreadyMerged = new Set<number>();
  let mergesApplied = 0;
  let nodesRemoved = 0;
  let meshesRemoved = 0;

  for (const merge of params.merges) {
    if (!merge || typeof merge.name !== 'string' || merge.name.length === 0) {
      warnings.push('merges: entry with missing/empty name skipped');
      continue;
    }
    if (!Array.isArray(merge.member_indices) || merge.member_indices.length < 2) {
      warnings.push(`merge "${merge.name}": need at least 2 members, skipped`);
      continue;
    }

    const members: GLTFNode[] = [];
    const seen = new Set<number>();
    for (const idx of merge.member_indices) {
      if (!Number.isInteger(idx)) {
        warnings.push(`merge "${merge.name}": non-integer member ${idx} skipped`);
        continue;
      }
      if (seen.has(idx)) {
        warnings.push(`merge "${merge.name}": duplicate member ${idx} skipped`);
        continue;
      }
      if (alreadyMerged.has(idx)) {
        warnings.push(
          `merge "${merge.name}": member ${idx} already in another merge, skipped`,
        );
        continue;
      }
      const n = byIndex.get(idx);
      if (!n) {
        warnings.push(`merge "${merge.name}": member ${idx} out of range, skipped`);
        continue;
      }
      if (!n.getMesh()) {
        warnings.push(`merge "${merge.name}": node ${idx} has no mesh, skipped`);
        continue;
      }
      seen.add(idx);
      members.push(n);
    }

    if (members.length < 2) {
      warnings.push(
        `merge "${merge.name}": fewer than 2 valid members after filtering, skipped`,
      );
      continue;
    }

    // Bucket primitives by material.
    const buckets = new Map<Material | null, PrimItem[]>();
    for (const memberNode of members) {
      const wm = getWorldMatrix(memberNode, nodeParentOnly);
      const mesh = memberNode.getMesh()!;
      for (const prim of mesh.listPrimitives()) {
        const mat = prim.getMaterial();
        const list = buckets.get(mat) ?? [];
        list.push({ prim, worldMatrix: wm });
        buckets.set(mat, list);
      }
    }
    if (buckets.size > 1) {
      warnings.push(
        `merge "${merge.name}": members span ${buckets.size} materials — result mesh has ${buckets.size} primitives (one per material)`,
      );
    }

    const droppedAttrs = new Set<string>();
    const newMesh = doc.createMesh(`${merge.name}_mesh`);
    for (const [mat, items] of buckets) {
      const mergedPrim = mergePrimitivesForMaterial(doc, items, droppedAttrs);
      if (mat) mergedPrim.setMaterial(mat);
      newMesh.addPrimitive(mergedPrim);
    }
    if (droppedAttrs.size > 0) {
      warnings.push(
        `merge "${merge.name}": attribute(s) ${[...droppedAttrs].join(', ')} were not present in every member, dropped from merged result`,
      );
    }

    const newNode = doc.createNode(merge.name);
    newNode.setMesh(newMesh);
    // Identity transform — geometry is already baked into world space.

    // Attach to common parent when all members share one, else scene root.
    const firstParent = nodeOrSceneParent.get(members[0]) ?? null;
    let attachTo: GLTFNode | Scene = scene;
    if (firstParent) {
      const allShare = members.every((m) => nodeOrSceneParent.get(m) === firstParent);
      if (allShare) {
        attachTo = firstParent;
      } else {
        warnings.push(
          `merge "${merge.name}": members have different original parents — new node attached to scene root`,
        );
      }
    }
    attachTo.addChild(newNode);

    // Dispose each member's node + (if unused elsewhere) its mesh.
    for (const m of members) {
      const oldMesh = m.getMesh();
      const p = nodeOrSceneParent.get(m);
      if (p) (p as GLTFNode | Scene).removeChild(m);
      m.dispose();
      nodesRemoved++;
      if (oldMesh) {
        const stillUsed = allNodes.some((n) => n !== m && n.getMesh() === oldMesh);
        if (!stillUsed) {
          oldMesh.dispose();
          meshesRemoved++;
        }
      }
      alreadyMerged.add(allNodes.indexOf(m));
    }

    mergesApplied++;
  }

  // Clean up orphan accessors / materials / etc. Prune is idempotent.
  await doc.transform(prune());

  const srcBase = path.basename(params.glb_path, path.extname(params.glb_path));
  const outputPath = path.join(getOutputDir(), `merged_${Date.now()}_${srcBase}.glb`);
  await io.write(outputPath, doc);

  const assetId = `merged_${Date.now()}`;
  trackSessionAsset({
    id: assetId,
    type: 'model',
    filePath: outputPath,
    sourceImagePath: params.glb_path,
    createdAt: new Date().toISOString(),
  });

  return {
    output_path: outputPath,
    applied_merges: mergesApplied,
    removed_nodes: nodesRemoved,
    removed_meshes: meshesRemoved,
    warnings,
    source: params.glb_path,
    asset_id: assetId,
  };
}
