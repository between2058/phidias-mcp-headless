/**
 * apply_part_names — rename nodes and/or wrap groups of nodes under new parent
 * nodes in a GLB. Produces a NEW GLB; does not mutate the source file.
 *
 * Node indices here match the order returned by inspect_model
 * (i.e. root.listNodes() in glTF terms). That order is stable across
 * inspect/apply calls on the same source file, so a caller LLM can decide
 * names after inspect_model and pass the index → name map directly.
 */

import fs from 'node:fs';
import path from 'node:path';
import { NodeIO, Node, Scene } from '@gltf-transform/core';
import { getOutputDir, trackSessionAsset } from './phidias-client.js';

export interface ApplyGroupSpec {
  name: string;
  member_indices: number[];
}

export interface ApplyPartNamesParams {
  glb_path: string;
  names?: Record<string, string>;
  groups?: ApplyGroupSpec[];
}

export interface ApplyPartNamesResult {
  output_path: string;
  applied_names_count: number;
  applied_groups_count: number;
  warnings: string[];
  source: string;
  asset_id: string;
}

export async function applyPartNames(
  params: ApplyPartNamesParams,
): Promise<ApplyPartNamesResult> {
  if (!fs.existsSync(params.glb_path)) {
    throw new Error(`GLB file not found: ${params.glb_path}`);
  }

  const io = new NodeIO();
  const doc = await io.read(params.glb_path);
  const root = doc.getRoot();
  const allNodes = root.listNodes();
  const scenes = root.listScenes();

  if (scenes.length === 0) {
    throw new Error('GLB has no scene; nothing to modify');
  }
  const scene = scenes[0];

  const warnings: string[] = [];
  const byIndex = new Map<number, Node>();
  allNodes.forEach((n, i) => byIndex.set(i, n));

  // Snapshot the original parent of every node. We use this (not a live lookup)
  // when deciding where a new group should attach, so in-flight reparenting
  // caused by earlier groups in the same call does not confuse later ones.
  const originalParent = new Map<Node, Node | Scene | null>();
  for (const n of allNodes) originalParent.set(n, null);
  for (const s of scenes) {
    for (const child of s.listChildren()) originalParent.set(child, s);
  }
  for (const n of allNodes) {
    for (const child of n.listChildren()) originalParent.set(child, n);
  }

  // --- 1. Rename ---
  let namesApplied = 0;
  if (params.names) {
    for (const [key, newName] of Object.entries(params.names)) {
      const idx = Number(key);
      if (!Number.isInteger(idx)) {
        warnings.push(`names: non-integer key "${key}" skipped`);
        continue;
      }
      if (typeof newName !== 'string' || newName.length === 0) {
        warnings.push(`names: empty / non-string value for index ${idx} skipped`);
        continue;
      }
      const node = byIndex.get(idx);
      if (!node) {
        warnings.push(
          `names: index ${idx} out of range (max ${allNodes.length - 1}) skipped`,
        );
        continue;
      }
      node.setName(newName);
      namesApplied++;
    }
  }

  // --- 2. Group ---
  // Each group gets a fresh Node that adopts the listed members. A member can
  // only belong to one group per call; collisions are warned and skipped.
  let groupsApplied = 0;
  if (params.groups) {
    const alreadyGrouped = new Set<number>();

    for (const g of params.groups) {
      if (!g || typeof g.name !== 'string' || g.name.length === 0) {
        warnings.push('groups: entry with missing / empty name skipped');
        continue;
      }
      if (!Array.isArray(g.member_indices) || g.member_indices.length === 0) {
        warnings.push(`group "${g.name}": no members, skipped`);
        continue;
      }

      const memberNodes: Node[] = [];
      const seen = new Set<number>();
      for (const idx of g.member_indices) {
        if (!Number.isInteger(idx)) {
          warnings.push(`group "${g.name}": non-integer member ${idx} skipped`);
          continue;
        }
        if (seen.has(idx)) {
          warnings.push(`group "${g.name}": duplicate member ${idx} skipped`);
          continue;
        }
        if (alreadyGrouped.has(idx)) {
          warnings.push(
            `group "${g.name}": member ${idx} already in another group, skipped`,
          );
          continue;
        }
        const n = byIndex.get(idx);
        if (!n) {
          warnings.push(
            `group "${g.name}": member ${idx} out of range, skipped`,
          );
          continue;
        }
        seen.add(idx);
        memberNodes.push(n);
      }

      if (memberNodes.length === 0) {
        warnings.push(`group "${g.name}": no valid members after filtering, skipped`);
        continue;
      }

      // Where to attach the new group? Prefer the common original parent of all
      // members; fall back to the scene root with a warning otherwise.
      const firstParent = originalParent.get(memberNodes[0]) ?? null;
      let attachTo: Node | Scene = scene;
      if (firstParent) {
        const allShare = memberNodes.every(
          (m) => originalParent.get(m) === firstParent,
        );
        if (allShare) {
          attachTo = firstParent;
        } else {
          warnings.push(
            `group "${g.name}": members have different original parents; group attached to scene root`,
          );
        }
      }

      const groupNode = doc.createNode(g.name);
      attachTo.addChild(groupNode);

      for (const mn of memberNodes) {
        const currentParent = originalParent.get(mn);
        if (currentParent) {
          // Both Node and Scene have removeChild in gltf-transform.
          (currentParent as Node | Scene).removeChild(mn);
        }
        groupNode.addChild(mn);
        const idx = allNodes.indexOf(mn);
        if (idx >= 0) alreadyGrouped.add(idx);
      }

      groupsApplied++;
    }
  }

  // --- 3. Write new GLB ---
  const srcBase = path.basename(params.glb_path, path.extname(params.glb_path));
  const outputPath = path.join(
    getOutputDir(),
    `named_${Date.now()}_${srcBase}.glb`,
  );
  await io.write(outputPath, doc);

  const assetId = `named_${Date.now()}`;
  trackSessionAsset(
    {
      id: assetId,
      type: 'model',
      filePath: outputPath,
      sourceImagePath: params.glb_path,
      createdAt: new Date().toISOString(),
    },
    {
      tool: 'phidias.apply_part_names',
      name: 'named',
    },
  );

  return {
    output_path: outputPath,
    applied_names_count: namesApplied,
    applied_groups_count: groupsApplied,
    warnings,
    source: params.glb_path,
    asset_id: assetId,
  };
}
