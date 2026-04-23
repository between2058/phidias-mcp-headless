/**
 * inspect_gltf — structured introspection of a GLB / glTF file.
 *
 * Returns scene graph info (nodes, bboxes, centroids, mesh/material indices) as
 * plain JSON so an LLM caller can reason about the model without rendering.
 */

import fs from 'node:fs';
import { NodeIO, getBounds, type Node } from '@gltf-transform/core';

export interface InspectedNode {
  index: number;
  name: string;
  mesh_index: number | null;
  parent_index: number | null;
  children_indices: number[];
  world_bbox: [[number, number, number], [number, number, number]] | null;
  world_centroid: [number, number, number] | null;
  world_size: [number, number, number] | null;
  face_count: number;
}

export interface InspectedMaterial {
  index: number;
  name: string;
  base_color_rgba: [number, number, number, number] | null;
}

export interface InspectResult {
  scene: {
    num_nodes: number;
    num_meshes: number;
    num_materials: number;
    overall_bbox: [[number, number, number], [number, number, number]] | null;
    overall_size: [number, number, number] | null;
  };
  nodes: InspectedNode[];
  materials: InspectedMaterial[];
}

function round(n: number, digits = 4): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

function roundVec3(v: readonly number[]): [number, number, number] {
  return [round(v[0]), round(v[1]), round(v[2])];
}

function sizeFromBounds(
  bbox: { min: readonly number[]; max: readonly number[] },
): [number, number, number] {
  return [
    round(bbox.max[0] - bbox.min[0]),
    round(bbox.max[1] - bbox.min[1]),
    round(bbox.max[2] - bbox.min[2]),
  ];
}

function centroidFromBounds(
  bbox: { min: readonly number[]; max: readonly number[] },
): [number, number, number] {
  return [
    round((bbox.min[0] + bbox.max[0]) / 2),
    round((bbox.min[1] + bbox.max[1]) / 2),
    round((bbox.min[2] + bbox.max[2]) / 2),
  ];
}

function isFiniteBbox(bbox: { min: readonly number[]; max: readonly number[] }): boolean {
  return (
    bbox.min.every((v) => Number.isFinite(v)) && bbox.max.every((v) => Number.isFinite(v))
  );
}

export async function inspectGltf(glbPath: string): Promise<InspectResult> {
  if (!fs.existsSync(glbPath)) {
    throw new Error(`GLB file not found: ${glbPath}`);
  }

  const io = new NodeIO();
  const doc = await io.read(glbPath);
  const root = doc.getRoot();

  const allNodes = root.listNodes();
  const allMeshes = root.listMeshes();
  const allMaterials = root.listMaterials();
  const scenes = root.listScenes();

  const nodeIndex = new Map<Node, number>(allNodes.map((n, i) => [n, i]));
  const meshIndex = new Map(allMeshes.map((m, i) => [m, i]));

  // Build parent map: for each node, which index is its parent (or null).
  const parentOf = new Array<number | null>(allNodes.length).fill(null);
  allNodes.forEach((parent, pi) => {
    for (const child of parent.listChildren()) {
      const ci = nodeIndex.get(child);
      if (ci !== undefined) parentOf[ci] = pi;
    }
  });

  const nodes: InspectedNode[] = allNodes.map((node, i) => {
    const mesh = node.getMesh();
    const childrenIndices = node
      .listChildren()
      .map((c) => nodeIndex.get(c))
      .filter((x): x is number => x !== undefined);

    let world_bbox: InspectedNode['world_bbox'] = null;
    let world_centroid: InspectedNode['world_centroid'] = null;
    let world_size: InspectedNode['world_size'] = null;
    let face_count = 0;

    if (mesh) {
      try {
        const b = getBounds(node);
        if (b && isFiniteBbox(b)) {
          world_bbox = [roundVec3(b.min), roundVec3(b.max)];
          world_centroid = centroidFromBounds(b);
          world_size = sizeFromBounds(b);
        }
      } catch {
        // leave bbox null if gltf-transform can't compute it for this node
      }

      for (const prim of mesh.listPrimitives()) {
        const indices = prim.getIndices();
        const pos = prim.getAttribute('POSITION');
        const vertexCount = indices ? indices.getCount() : pos ? pos.getCount() : 0;
        face_count += Math.floor(vertexCount / 3);
      }
    }

    return {
      index: i,
      name: node.getName() || `node_${i}`,
      mesh_index: mesh ? meshIndex.get(mesh) ?? null : null,
      parent_index: parentOf[i],
      children_indices: childrenIndices,
      world_bbox,
      world_centroid,
      world_size,
      face_count,
    };
  });

  const materials: InspectedMaterial[] = allMaterials.map((mat, i) => {
    const color = mat.getBaseColorFactor();
    return {
      index: i,
      name: mat.getName() || `material_${i}`,
      base_color_rgba: color
        ? ([round(color[0]), round(color[1]), round(color[2]), round(color[3])] as [
            number,
            number,
            number,
            number,
          ])
        : null,
    };
  });

  let overall_bbox: InspectResult['scene']['overall_bbox'] = null;
  let overall_size: InspectResult['scene']['overall_size'] = null;
  if (scenes.length > 0) {
    try {
      const b = getBounds(scenes[0]);
      if (b && isFiniteBbox(b)) {
        overall_bbox = [roundVec3(b.min), roundVec3(b.max)];
        overall_size = sizeFromBounds(b);
      }
    } catch {
      // ignore; leave null
    }
  }

  return {
    scene: {
      num_nodes: allNodes.length,
      num_meshes: allMeshes.length,
      num_materials: allMaterials.length,
      overall_bbox,
      overall_size,
    },
    nodes,
    materials,
  };
}
