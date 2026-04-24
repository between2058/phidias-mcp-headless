#!/usr/bin/env node
/**
 * Phidias MCP Server (Headless)
 *
 * Exposes the Phidias 3D asset pipeline as MCP tools for Claude Code.
 * Tools: generate_image, generate_3d, segment_model, list_generated_assets
 *
 * Headless variant — no browser frontend, no WebSocket bridge.
 * All tools are pure backend operations that return file paths on disk.
 */

import http from 'node:http';
import fs from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import {
  generateImage,
  generate3D,
  segment3D,
  getSessionAssets,
  getOutputDir,
  findAssetById,
} from './phidias-client.js';
import { inspectGltf } from './inspect-model.js';
import { applyPartNames } from './apply-part-names.js';
import { mergeParts } from './merge-parts.js';
import {
  exportArticulation,
  MATERIAL_PRESET_KEYS,
} from './export-articulation.js';
import { serveFileIfMatch } from './file-serving.js';
import { buildPublicUrlBase, requestContext, makeFileUrl } from './request-context.js';

// ---------------------------------------------------------------------------
// Server factory — each HTTP request in stateless mode gets a fresh server,
// so tool registration lives in a function we can call per-connection.
// ---------------------------------------------------------------------------

function createServer(): McpServer {
  const server = new McpServer({
    name: 'phidias-headless',
    version: '0.1.0',
    description: 'Phidias 3D asset creation pipeline (headless) — generate images, 3D models, and segment meshes from the command line',
  });

  // -------------------------------------------------------------------------
  // Tool: generate_image
  // -------------------------------------------------------------------------

  server.tool(
    'generate_image',
    'Generate a reference image from a text prompt using Qwen AI. Returns the file path of the generated image. Use this as the first step to create a 3D model — generate a concept image, then pass it to generate_3d.',
    {
      prompt: z.string().describe('Text description of the image to generate (English recommended). Be specific about the subject, style, and viewing angle. For 3D model creation, include "front view" or "3/4 view" for best results.'),
      negative_prompt: z.string().optional().describe('Things to exclude from the image (e.g. "blurry, low quality, distorted")'),
      seed: z.number().int().optional().describe('Random seed for reproducibility. Omit for random results.'),
      num_steps: z.number().int().min(1).max(100).optional().describe('Number of diffusion steps (default: 50). Higher = better quality but slower.'),
      cfg_scale: z.number().min(0).max(20).optional().describe('CFG scale controlling prompt adherence (default: 4.0). Higher = more literal.'),
      aspect_ratio: z.enum(['1:1', '16:9', '9:16', '4:3', '3:4']).optional().describe('Image aspect ratio (default: 1:1). Use 1:1 for 3D model reference images.'),
    },
    async (params) => {
      try {
        const asset = await generateImage(params.prompt, {
          seed: params.seed,
          num_steps: params.num_steps,
          cfg_scale: params.cfg_scale,
          negative_prompt: params.negative_prompt,
          aspect_ratio: params.aspect_ratio,
        });

        const base64 = fs.readFileSync(asset.filePath).toString('base64');
        const textLines: string[] = [
          'Image generated successfully.',
          '',
          `File: ${asset.filePath}`,
        ];
        const url = makeFileUrl(asset.filePath);
        if (url) textLines.push(`URL: ${url}`);
        textLines.push(`Prompt: "${params.prompt}"`);
        textLines.push(`Asset ID: ${asset.id}`);
        textLines.push('', 'Next step: Use generate_3d with this image path or URL to create a 3D model.');

        return {
          content: [
            { type: 'image' as const, data: base64, mimeType: 'image/png' },
            { type: 'text' as const, text: textLines.join('\n') },
          ],
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: 'text' as const, text: `Error generating image: ${msg}` }],
          isError: true,
        };
      }
    },
  );

  // -------------------------------------------------------------------------
  // Tool: generate_3d
  // -------------------------------------------------------------------------

  server.tool(
    'generate_3d',
    `Generate a textured 3D model (GLB) from a reference image. Two backends available:
- trellis2 (default): HIGH QUALITY, detailed topology, high face count. Slower (~3min). Use for final assets or when quality matters.
- reconviagen: FAST (~1min), lower detail. Use for quick previews or rapid iteration.
If the user hasn't specified which backend to use, ask them. Returns the file path of the generated GLB.`,
    {
      image_path: z.string().describe('Absolute file path to the reference image (PNG/JPG). Can be a path from generate_image output or any local image file.'),
      backend: z.enum(['trellis2', 'reconviagen']).default('trellis2').describe('Which 3D generation backend to use. trellis2 = high quality/slow, reconviagen = fast/preview.'),
      seed: z.number().int().optional().describe('Random seed for reproducibility. Omit for random results.'),
      texture_size: z.number().int().optional().describe('Texture resolution (default: 1024). Options: 512, 1024, 2048. Higher = more detailed textures but larger file.'),
      ss_guidance_strength: z.number().optional().describe('Structure guidance strength (default: 7.5). Controls how closely the 3D shape follows the image.'),
      ss_sampling_steps: z.number().int().optional().describe('Structure sampling steps (default: 12).'),
      slat_guidance_strength: z.number().optional().describe('Texture guidance strength (default: 3.0). Controls texture fidelity.'),
      slat_sampling_steps: z.number().int().optional().describe('Texture sampling steps (default: 12).'),
    },
    async (params) => {
      try {
        const asset = await generate3D(params.image_path, {
          backend: params.backend,
          seed: params.seed,
          texture_size: params.texture_size,
          ss_guidance_strength: params.ss_guidance_strength,
          ss_sampling_steps: params.ss_sampling_steps,
          slat_guidance_strength: params.slat_guidance_strength,
          slat_sampling_steps: params.slat_sampling_steps,
        });

        const lines: string[] = [
          `3D model generated successfully (${params.backend}).`,
          '',
          `File: ${asset.filePath}`,
        ];
        const url = makeFileUrl(asset.filePath);
        if (url) lines.push(`URL: ${url}`);
        lines.push(`Source image: ${asset.sourceImagePath}`);
        lines.push(`Asset ID: ${asset.id}`);

        return {
          content: [{ type: 'text' as const, text: lines.join('\n') }],
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: 'text' as const, text: `Error generating 3D model: ${msg}` }],
          isError: true,
        };
      }
    },
  );

  // -------------------------------------------------------------------------
  // Tool: segment_model
  // -------------------------------------------------------------------------

  server.tool(
    'segment_model',
    'Segment a 3D model (GLB) into individual parts using P3-SAM AI. Splits a single mesh into meaningful parts (e.g. head, body, legs, arms). Takes 1-3 minutes. Returns the file path of the segmented GLB and the number of parts.',
    {
      glb_path: z.string().describe('Absolute path to a GLB file to segment.'),
      point_num: z.number().int().min(1000).max(20000).optional().describe('Number of sample points (P3-SAM backend requires >= 1000; default: backend default).'),
      prompt_num: z.number().int().min(10).max(200).optional().describe('Number of prompts for segmentation (P3-SAM backend requires >= 10; default: backend default).'),
      threshold: z.number().min(0).max(1).optional().describe('Segmentation threshold (default: 0.5). Lower = more parts, higher = fewer parts.'),
      seed: z.number().int().optional().describe('Random seed for reproducibility.'),
    },
    async (params) => {
      try {
        const result = await segment3D(params.glb_path, {
          point_num: params.point_num,
          prompt_num: params.prompt_num,
          threshold: params.threshold,
          seed: params.seed,
        });

        const lines: string[] = [
          `Model segmented successfully into ${result.numParts} parts.`,
          '',
          `File: ${result.filePath}`,
        ];
        const url = makeFileUrl(result.filePath);
        if (url) lines.push(`URL: ${url}`);
        lines.push(`Parts: ${result.numParts}`);
        lines.push(`Source: ${params.glb_path}`);

        return {
          content: [{ type: 'text' as const, text: lines.join('\n') }],
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: 'text' as const, text: `Error segmenting model: ${msg}` }],
          isError: true,
        };
      }
    },
  );

  // -------------------------------------------------------------------------
  // Tool: inspect_model
  // -------------------------------------------------------------------------

  server.tool(
    'inspect_model',
    `Inspect the structure of a GLB/glTF file and return it as JSON. Reports every node's world-space bounding box, centroid, size, face count, mesh/material indices, and parent/child relationships, plus scene-level totals and material base colors.

Use this BEFORE trying to rename or regroup segmented parts. Spatial clues (centroid position, bbox size, which nodes share a parent) often let you name most parts from structure alone — e.g., the node with the largest Y-extent is probably the frame, the many small thin nodes stacked along Y are rack units, etc.

No rendering is performed; this is pure scene-graph introspection and returns quickly. Node indices reported here are stable and can be passed to apply_part_names to rename / regroup nodes.`,
    {
      glb_path: z.string().describe('Absolute path to a GLB (or glTF) file to inspect.'),
      max_nodes: z.number().int().min(1).max(10000).optional().describe('If the file has more nodes than this, the response truncates the `nodes` array to save context. Default: 500.'),
    },
    async ({ glb_path, max_nodes }) => {
      try {
        const result = await inspectGltf(glb_path);
        const limit = max_nodes ?? 500;
        const truncated = result.nodes.length > limit;
        const payload = truncated
          ? {
              ...result,
              nodes: result.nodes.slice(0, limit),
              _truncated: {
                shown: limit,
                total: result.nodes.length,
                note: `Response truncated to the first ${limit} nodes. Pass max_nodes to see more.`,
              },
            }
          : result;

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(payload, null, 2),
            },
          ],
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: 'text' as const, text: `Error inspecting GLB: ${msg}` }],
          isError: true,
        };
      }
    },
  );

  // -------------------------------------------------------------------------
  // Tool: apply_part_names
  // -------------------------------------------------------------------------

  server.tool(
    'apply_part_names',
    `Rename nodes and/or wrap groups of nodes under new parent nodes in a GLB, producing a NEW file (the source is never modified).

Node indices match the order returned by inspect_model. Call inspect_model first to see what indices exist, decide names / groupings from spatial structure, then call this tool once with the resulting map.

Grouping: each entry in \`groups\` creates a new parent node with the given name and moves the listed members to become its children. If all members share the same original parent, the new group is attached there; otherwise it is attached to the scene root and a warning is emitted. A node can belong to only one group per call.

IMPORTANT: \`groups\` only reparents nodes — the group node itself has NO mesh geometry. If the eventual goal is export_articulation (physics), do NOT use \`groups\` to produce a part: the empty group node is dropped by the physics JSON pipeline and the resulting articulation will be broken. Use \`merge_parts\` instead to fuse fragments into a single real mesh, then name that merged node with this tool. Use \`groups\` only for scene-graph organisation that is purely cosmetic.

Returns the output GLB path + URL and an asset_id that can be passed to download_asset.`,
    {
      glb_path: z.string().describe('Absolute path to the source GLB.'),
      names: z
        .record(z.string(), z.string())
        .optional()
        .describe('Map of node index (as string key) to new name. Example: {"1": "front_door", "2": "rack_unit_0"}. Nodes not listed keep their original names.'),
      groups: z
        .array(
          z.object({
            name: z.string().describe('Name of the new parent group node.'),
            member_indices: z
              .array(z.number().int().nonnegative())
              .describe('Indices of nodes that become children of the group (reparented from their original location).'),
          }),
        )
        .optional()
        .describe('Optional list of grouping instructions. Each creates a new named parent Node above its listed members.'),
    },
    async (params) => {
      try {
        const result = await applyPartNames({
          glb_path: params.glb_path,
          names: params.names,
          groups: params.groups,
        });

        const lines: string[] = [
          'Part names applied successfully.',
          '',
          `File: ${result.output_path}`,
        ];
        const url = makeFileUrl(result.output_path);
        if (url) lines.push(`URL: ${url}`);
        lines.push(`Asset ID: ${result.asset_id}`);
        lines.push(`Names applied: ${result.applied_names_count}`);
        lines.push(`Groups applied: ${result.applied_groups_count}`);
        lines.push(`Source: ${result.source}`);
        if (result.warnings.length > 0) {
          lines.push('', 'Warnings:');
          for (const w of result.warnings) lines.push(`  - ${w}`);
        }

        return {
          content: [{ type: 'text' as const, text: lines.join('\n') }],
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: 'text' as const, text: `Error applying part names: ${msg}` }],
          isError: true,
        };
      }
    },
  );

  // -------------------------------------------------------------------------
  // Tool: merge_parts
  // -------------------------------------------------------------------------

  server.tool(
    'merge_parts',
    `Physically fuse a set of GLB nodes into a single node (geometry-level merge). Use this to clean up over-segmented models — e.g., when segment_model produces many tiny fragments that should be one part.

How it differs from apply_part_names groups: apply_part_names only reparents nodes (they remain selectable separately); merge_parts combines vertex buffers so the merged result is truly one mesh. Original member nodes are removed.

Semantics:
- Node indices match inspect_model's order.
- Each member's geometry is transformed to world space, then combined.
- Members with different materials stay valid: the merged mesh carries one primitive per material.
- A node can appear in at most one merge per call.
- The new node has an identity transform (vertex data is baked in world space).
- The new node is attached to the members' common original parent when they share one; otherwise to the scene root (warning emitted).
- Members without a mesh are skipped.

Call inspect_model first to see indices, then decide which clusters to merge. Typically follows this pattern: segment_model → inspect_model → merge_parts → inspect_model again → apply_part_names.`,
    {
      glb_path: z.string().describe('Absolute path to the source GLB.'),
      merges: z
        .array(
          z.object({
            name: z.string().describe('Name of the resulting merged node and its mesh.'),
            member_indices: z
              .array(z.number().int().nonnegative())
              .min(2)
              .describe('Indices of at least 2 nodes whose geometry will be fused into one.'),
          }),
        )
        .min(1)
        .describe('One or more merge instructions. Each combines the listed members into one new node.'),
    },
    async (params) => {
      try {
        const result = await mergeParts({
          glb_path: params.glb_path,
          merges: params.merges,
        });

        const lines: string[] = [
          'Parts merged successfully.',
          '',
          `File: ${result.output_path}`,
        ];
        const url = makeFileUrl(result.output_path);
        if (url) lines.push(`URL: ${url}`);
        lines.push(`Asset ID: ${result.asset_id}`);
        lines.push(`Merges applied: ${result.applied_merges}`);
        lines.push(`Nodes removed: ${result.removed_nodes}`);
        lines.push(`Meshes removed: ${result.removed_meshes}`);
        lines.push(`Source: ${result.source}`);
        if (result.warnings.length > 0) {
          lines.push('', 'Warnings:');
          for (const w of result.warnings) lines.push(`  - ${w}`);
        }

        return {
          content: [{ type: 'text' as const, text: lines.join('\n') }],
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: 'text' as const, text: `Error merging parts: ${msg}` }],
          isError: true,
        };
      }
    },
  );

  // -------------------------------------------------------------------------
  // Tool: export_articulation
  // -------------------------------------------------------------------------

  server.tool(
    'export_articulation',
    `Export a physics-ready articulation (USDA or USDZ) from a GLB plus a description of its rigid bodies and joints. This replaces what a human user would do in the Phidias Physics tab: assign materials, set mass / collision / friction per part, lay out the joint topology, and click "export".

Typical pipeline:
  segment_model → inspect_model → (optional merge_parts) → apply_part_names
                                                        → export_articulation

Node indices from inspect_model are NOT used directly here — the backend identifies parts by string \`id\`. A natural convention is to use the node name (after apply_part_names) as the id, then the joint \`parent\` / \`child\` fields reference those ids.

Every \`parts[].id\` MUST correspond to a GLB node that directly carries a mesh. Empty group nodes (produced by apply_part_names \`groups:\`) are rejected pre-flight — fuse their children with merge_parts first. The tool also re-writes the emitted phidias.physics.v1 JSON so part ids match the GLB node names, which is what the Phidias Physics Editor's MotionPreviewController uses to bind joints to meshes.

Material presets are expanded client-side. If a part has \`material_preset: "steel"\`, density / friction / restitution are filled from a preset table (see the enum in the schema). Explicit numeric fields override the preset.

Returns the local path and URL of the produced USD file plus an asset_id usable with download_asset.`,
    {
      glb_path: z.string().describe('Absolute path to the GLB the articulation describes (typically the output of apply_part_names or merge_parts).'),
      model_name: z.string().min(1).describe('Name for the articulation root, used inside the USD output (e.g. "server_rack", "ur5_arm").'),
      format: z.enum(['usda', 'usdz']).describe('USDA (text, external textures) or USDZ (zipped, self-contained).'),
      parts: z
        .array(
          z.object({
            id: z.string().describe('Unique part identifier. Joints reference this in parent/child.'),
            name: z.string().describe('Human-readable display name.'),
            type: z.enum(['link', 'base', 'tool', 'joint']).optional().describe('Semantic type. Exactly one part should usually be "base" (the fixed root).'),
            role: z.enum(['actuator', 'support', 'gripper', 'sensor', 'other']).optional(),
            mobility: z.enum(['fixed', 'revolute', 'prismatic']).optional().describe('How this body moves relative to its parent. Default "fixed".'),
            mass: z.number().positive().nullable().optional().describe('Mass in kg. Leave null/omit to let the backend auto-compute from density × volume.'),
            density: z.number().positive().optional().describe('kg/m³. Used to auto-compute mass when mass is null. Default 1000.'),
            center_of_mass: z.tuple([z.number(), z.number(), z.number()]).nullable().optional().describe('Override the centre of mass in local coordinates.'),
            collision_type: z.enum(['mesh', 'convexHull', 'convexDecomposition', 'none']).optional().describe('Default "convexHull".'),
            static_friction: z.number().min(0).optional(),
            dynamic_friction: z.number().min(0).optional(),
            restitution: z.number().min(0).max(1).optional(),
            material_preset: z
              .enum(MATERIAL_PRESET_KEYS)
              .optional()
              .describe('Optional shortcut that fills density + frictions + restitution from a preset. Explicit numeric fields override this.'),
          }),
        )
        .min(1)
        .describe('Array of rigid bodies. Every joint reference must resolve to one of these ids.'),
      joints: z
        .array(
          z.object({
            name: z.string(),
            parent: z.string().describe('Parent part id. Must match an entry in parts[].id.'),
            child: z.string().describe('Child part id. Must match an entry in parts[].id.'),
            type: z.enum(['fixed', 'revolute', 'prismatic']).optional().describe('Default "revolute".'),
            axis: z.tuple([z.number(), z.number(), z.number()]).optional().describe('Axis of motion in world space. Need not be normalised. Default [0,0,1].'),
            anchor: z.tuple([z.number(), z.number(), z.number()]).optional().describe('Pivot point relative to the child body. Default [0,0,0] (child origin). Useful to set to the world_centroid of the joint location.'),
            lower_limit: z.number().nullable().optional().describe('Degrees for revolute, metres for prismatic. null = unlimited.'),
            upper_limit: z.number().nullable().optional(),
            drive_stiffness: z.number().min(0).nullable().optional(),
            drive_damping: z.number().min(0).nullable().optional(),
            drive_max_force: z.number().min(0).nullable().optional(),
            drive_type: z.enum(['position', 'velocity', 'none']).optional(),
            disable_collision: z.boolean().optional().describe('Disable collision between parent and child of this joint. Default true.'),
          }),
        )
        .describe('Array of joints linking parts into a kinematic structure. Can be empty for a single rigid body.'),
      emit_physics_json: z
        .boolean()
        .optional()
        .describe(
          'If true (default for USDZ), also emit a phidias.physics.v1 JSON next to the USDZ by running the official usdz_to_phidias_physics.py converter. This JSON is what the Phidias frontend Physics Editor\'s "Import Config" button accepts directly. Requires `python3` and `usdcat` on PATH. Ignored for USDA output. Conversion failures are reported as warnings and do not fail the USDZ export.',
        ),
    },
    async (params) => {
      try {
        const result = await exportArticulation({
          glb_path: params.glb_path,
          model_name: params.model_name,
          parts: params.parts,
          joints: params.joints,
          format: params.format,
          emit_physics_json: params.emit_physics_json,
        });

        const lines: string[] = [
          `Articulation exported successfully (${result.format.toUpperCase()}).`,
          '',
          `File: ${result.output_path}`,
        ];
        const url = makeFileUrl(result.output_path);
        if (url) lines.push(`URL: ${url}`);
        lines.push(`Asset ID: ${result.asset_id}`);
        lines.push(`Backend filename: ${result.backend_filename}`);
        lines.push(`Parts: ${result.parts_count}`);
        lines.push(`Joints: ${result.joints_count}`);
        if (result.presets_expanded > 0) {
          lines.push(`Material presets expanded: ${result.presets_expanded}`);
        }
        lines.push(`Source GLB: ${result.source}`);
        if (result.physics_json_path) {
          lines.push('');
          lines.push(`Physics config JSON: ${result.physics_json_path}`);
          const jsonUrl = makeFileUrl(result.physics_json_path);
          if (jsonUrl) lines.push(`Physics config URL: ${jsonUrl}`);
          if (result.physics_json_asset_id) {
            lines.push(`Physics config asset ID: ${result.physics_json_asset_id}`);
          }
          lines.push('(phidias.physics.v1 — import via Physics Editor "Import Config" button)');
        }
        if (result.warnings.length > 0) {
          lines.push('', 'Warnings:');
          for (const w of result.warnings) lines.push(`  - ${w}`);
        }

        return {
          content: [{ type: 'text' as const, text: lines.join('\n') }],
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: 'text' as const, text: `Error exporting articulation: ${msg}` }],
          isError: true,
        };
      }
    },
  );

  // -------------------------------------------------------------------------
  // Tool: download_asset
  // -------------------------------------------------------------------------

  server.tool(
    'download_asset',
    'Retrieve a previously generated asset by its asset ID. For images, returns the image inline so Claude can see (and save) it. For 3D models, returns a download URL (HTTP mode) or local path (stdio mode) that the client can fetch.',
    {
      asset_id: z.string().describe('Asset ID from list_generated_assets or a previous generation tool, e.g. "img_1776913747916".'),
    },
    async ({ asset_id }) => {
      const asset = findAssetById(asset_id);
      if (!asset) {
        return {
          content: [{ type: 'text' as const, text: `Asset not found: ${asset_id}. Use list_generated_assets to see available assets.` }],
          isError: true,
        };
      }

      if (asset.type === 'image') {
        const base64 = fs.readFileSync(asset.filePath).toString('base64');
        const textLines = [`Asset ${asset.id} (image)`, `File: ${asset.filePath}`];
        const url = makeFileUrl(asset.filePath);
        if (url) textLines.push(`URL: ${url}`);
        return {
          content: [
            { type: 'image' as const, data: base64, mimeType: 'image/png' },
            { type: 'text' as const, text: textLines.join('\n') },
          ],
        };
      }

      // 3D model
      const lines = [`Asset ${asset.id} (3d model)`, `File: ${asset.filePath}`];
      const url = makeFileUrl(asset.filePath);
      if (url) lines.push(`Download: ${url}`);
      else lines.push('Stdio mode — the client is on the same machine; read from File path directly.');
      return {
        content: [{ type: 'text' as const, text: lines.join('\n') }],
      };
    },
  );

  // -------------------------------------------------------------------------
  // Tool: list_generated_assets
  // -------------------------------------------------------------------------

  server.tool(
    'list_generated_assets',
    'List all images and 3D models generated in the current session. Shows file paths, types, prompts, and creation times.',
    {},
    async () => {
      const assets = getSessionAssets();

      if (assets.length === 0) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `No assets generated yet in this session.\n\nOutput directory: ${getOutputDir()}\n\nUse generate_image to create a reference image, then generate_3d to create a 3D model.`,
            },
          ],
        };
      }

      const lines = assets.map((a, i) => {
        const parts = [
          `${i + 1}. [${a.type.toUpperCase()}] ${a.filePath}`,
        ];
        const url = makeFileUrl(a.filePath);
        if (url) parts.push(`   URL: ${url}`);
        if (a.prompt) parts.push(`   Prompt: "${a.prompt}"`);
        if (a.sourceImagePath) parts.push(`   Source: ${a.sourceImagePath}`);
        parts.push(`   Asset ID: ${a.id}`);
        parts.push(`   Created: ${a.createdAt}`);
        return parts.join('\n');
      });

      return {
        content: [
          {
            type: 'text' as const,
            text: [
              `Generated assets (${assets.length}):`,
              `Output directory: ${getOutputDir()}`,
              ``,
              ...lines,
            ].join('\n'),
          },
        ],
      };
    },
  );

  return server;
}

// ---------------------------------------------------------------------------
// Transports
// ---------------------------------------------------------------------------

async function startStdio(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

async function startHttp(port: number, host: string, token: string | undefined): Promise<void> {
  const httpServer = http.createServer(async (req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', server: 'phidias-mcp-headless' }));
      return;
    }

    // File retrieval (same auth posture as /mcp)
    if (serveFileIfMatch(req, res, token)) return;

    if (!req.url || !req.url.startsWith('/mcp')) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found. MCP endpoint is at /mcp, files at /files/<name>');
      return;
    }

    if (token) {
      const auth = req.headers.authorization;
      if (auth !== `Bearer ${token}`) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unauthorized: missing or invalid bearer token' }));
        return;
      }
    }

    const requestServer = createServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    res.on('close', () => {
      transport.close().catch(() => {});
      requestServer.close().catch(() => {});
    });

    const publicUrlBase = buildPublicUrlBase(req);
    await requestContext.run({ publicUrlBase }, async () => {
      try {
        await requestServer.connect(transport);
        await transport.handleRequest(req, res);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`[phidias-mcp] handleRequest error: ${msg}\n`);
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: msg }));
        }
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(port, host, () => {
      httpServer.off('error', reject);
      const authStatus = token
        ? 'auth: Bearer token required'
        : 'auth: NONE — anyone on the network can call tools';
      process.stderr.write(
        `[phidias-mcp] HTTP mode listening on http://${host}:${port}/mcp (${authStatus})\n`,
      );
      resolve();
    });
  });
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const rawPort = process.env.MCP_HTTP_PORT;
  if (rawPort) {
    const port = Number.parseInt(rawPort, 10);
    if (!Number.isFinite(port) || port <= 0 || port > 65535) {
      throw new Error(`Invalid MCP_HTTP_PORT: ${rawPort}`);
    }
    const host = process.env.MCP_HTTP_HOST || '0.0.0.0';
    const token = process.env.MCP_HTTP_TOKEN;
    await startHttp(port, host, token);
  } else {
    await startStdio();
  }
}

main().catch((err) => {
  console.error('Phidias MCP server failed to start:', err);
  process.exit(1);
});
