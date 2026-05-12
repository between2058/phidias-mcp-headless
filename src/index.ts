#!/usr/bin/env node
/**
 * Phidias MCP Server (Headless)
 *
 * Exposes the Phidias 3D asset pipeline as MCP tools for Claude Code.
 * Tools: generate_image, upload_image, upload_from_url, generate_3d, segment_model, export_articulation, export_for_arkit, list_generated_assets
 *
 * Headless variant — no browser frontend, no WebSocket bridge.
 * All tools are pure backend operations that return file paths on disk.
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
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
  seedAssetsFromDir,
} from './phidias-client.js';
import { inspectGltf } from './inspect-model.js';
import { applyPartNames } from './apply-part-names.js';
import { mergeParts } from './merge-parts.js';
import { scaleModel } from './scale-model.js';
import { groundModel } from './ground-model.js';
import {
  exportArticulation,
  MATERIAL_PRESET_KEYS,
} from './export-articulation.js';
import { uploadImage, uploadImageFromUrl, saveImageBuffer } from './upload-image.js';
import { serveFileIfMatch } from './file-serving.js';
import { buildPublicUrlBase, requestContext, makeFileUrl } from './request-context.js';
import { sessionBus, type SessionEvent } from './event-bus.js';

// ---------------------------------------------------------------------------
// Server factory — each HTTP request in stateless mode gets a fresh server,
// so tool registration lives in a function we can call per-connection.
// ---------------------------------------------------------------------------

function createServer(): McpServer {
  const server = new McpServer(
    {
      name: 'phidias-headless',
      version: '0.1.0',
      description: 'Phidias 3D asset creation pipeline (headless) — generate images, 3D models, and segment meshes from the command line',
    },
    {
      instructions: `Phidias produces 3D assets at three different levels of completeness. Match the user's request to the right endpoint:

- "image" / "concept" / "reference image"  → generate_image
- "3D model" / "mesh" / "GLB"               → generate_3d
- "sim-ready" / "physics-ready" / "articulated" / "Isaac Sim" / "Omniverse" / "USD(Z)" / "rigged for simulation"
  → run the FULL pipeline, do not stop at segmentation:
       generate_3d  (or start from an existing GLB)
    →  scale_model  (real-world meters)
    →  ground_model (centre / drop to floor)
    →  segment_model
    →  inspect_model (decide which fragments belong together)
    →  merge_parts  (fuse fragments that should be one rigid body)
    →  apply_part_names (give each rigid body a stable id)
    →  export_articulation (USDA / USDZ + phidias.physics.v1 JSON)  ← THIS is the sim-ready endpoint

A segmented GLB by itself is NOT sim-ready. If the user asked for "sim-ready" and you only ran segment_model, the task is unfinished — keep going through merge_parts, apply_part_names, and export_articulation.`,
    },
  );

  // -------------------------------------------------------------------------
  // Tool: generate_image
  // -------------------------------------------------------------------------

  server.tool(
    'generate_image',
    `Generate a reference image from a text prompt. Returns the file path of the generated image. Use this as the first step to create a 3D model — generate a concept image, then pass it to generate_3d.

PREFLIGHT — check seed assets first. If the user named a specific real-world subject (e.g. "gb300", "Aeron chair", "RTX 4090"), call list_generated_assets BEFORE generating and look for an entry whose Asset ID starts with "seed_" and whose stem matches the subject (e.g. "gb300" → seed_gb300, seed_GB300, seed_gb_300). Match case-insensitively and treat hyphens/underscores/spaces as equivalent. If a match exists, SKIP generate_image entirely and pass that seed asset's File path directly to generate_3d — seed images are pre-curated references and must be preferred over freshly generated ones.`,
    {
      prompt: z.string().describe('Text description of the image to generate (English recommended). Be specific about the subject, style, and viewing angle. For 3D model creation, include "front view" or "3/4 view" for best results.'),
      negative_prompt: z.string().optional().describe('Things to exclude from the image (e.g. "blurry, low quality, distorted")'),
      seed: z.number().int().optional().describe('Random seed for reproducibility. Omit for random results.'),
      num_steps: z.number().int().min(1).max(100).default(25).describe('Number of diffusion steps (default: 25). Higher = better quality but slower.'),
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
  // Tool: upload_image
  // -------------------------------------------------------------------------

  server.tool(
    'upload_image',
    `Upload a base64-encoded image (PNG/JPEG/WEBP) as the reference for the 3D pipeline. Use this only for tiny images (< ~10 KB raw / < ~14 KB base64) that are already in the agent's context.

⚠️ FOR ANY REAL IMAGE FILE ON DISK, DO NOT USE THIS TOOL — Claude Code's Bash tool truncates command output, so piping \`base64 < photo.png\` into image_data corrupts the file silently. Instead, upload via the HTTP endpoint:

  curl --data-binary @/path/to/photo.png \\
       -H "Content-Type: image/png" \\
       "<server-base-url>/api/upload?filename=photo.png"

The response is JSON { asset_id, file_path, file_url } and file_path can be passed straight to generate_3d. The server base URL is the same one returned by other tools' bridge URLs.`,
    {
      image_data: z.string().describe('The image as a base64 string. May include the "data:image/...;base64," prefix. Use only for tiny images already in the agent context — for files on disk use POST /api/upload.'),
      filename: z.string().optional().describe('Original filename for display only.'),
      note: z.string().optional().describe('Optional human-readable note about this image.'),
    },
    async (params) => {
      try {
        const asset = await uploadImage(params);

        const base64Preview = fs.readFileSync(asset.filePath).toString('base64');
        const textLines: string[] = [
          'Image uploaded successfully.',
          '',
          `File: ${asset.filePath}`,
        ];
        const url = makeFileUrl(asset.filePath);
        if (url) textLines.push(`URL: ${url}`);
        textLines.push(`Asset ID: ${asset.id}`);
        textLines.push('', 'Next step: Use generate_3d with this image path to create a 3D model.');

        return {
          content: [
            { type: 'image' as const, data: base64Preview, mimeType: 'image/png' },
            { type: 'text' as const, text: textLines.join('\n') },
          ],
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: 'text' as const, text: `Error uploading image: ${msg}` }],
          isError: true,
        };
      }
    },
  );

  // -------------------------------------------------------------------------
  // Tool: upload_from_url
  // -------------------------------------------------------------------------

  server.tool(
    'upload_from_url',
    `Download an image (PNG/JPEG/WEBP) from a URL on the server side, save it into the asset pipeline, and return its file_path. Designed for agent platforms that cannot run shell commands (and therefore cannot curl /api/upload) and cannot reliably pass large base64 blobs through tool params.

The URL must be reachable from the MCP server. Common sources: presigned cloud-storage URLs (S3/GCS/Azure), public CDNs, the host platform's own image storage, or any HTTP(S) URL the server can resolve. Follows redirects, 30s default timeout, 50 MB cap. Returns { file_path, asset_id, file_url } where file_path can be passed straight to generate_3d.`,
    {
      url: z.string().describe('HTTP or HTTPS URL of the image to fetch. Must be reachable from the MCP server.'),
      filename: z.string().optional().describe('Original filename for display only. If omitted, derived from the URL path basename.'),
      note: z.string().optional().describe('Optional human-readable note about this image.'),
      timeout_ms: z.number().int().min(1000).max(300_000).optional().describe('Fetch timeout in milliseconds (default: 30000, max: 300000).'),
    },
    async (params) => {
      try {
        const asset = await uploadImageFromUrl(params);

        const base64Preview = fs.readFileSync(asset.filePath).toString('base64');
        const textLines: string[] = [
          'Image fetched and uploaded successfully.',
          '',
          `File: ${asset.filePath}`,
        ];
        const url = makeFileUrl(asset.filePath);
        if (url) textLines.push(`URL: ${url}`);
        textLines.push(`Asset ID: ${asset.id}`);
        textLines.push(`Source URL: ${params.url}`);
        textLines.push('', 'Next step: Use generate_3d with this image path to create a 3D model.');

        return {
          content: [
            { type: 'image' as const, data: base64Preview, mimeType: 'image/png' },
            { type: 'text' as const, text: textLines.join('\n') },
          ],
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: 'text' as const, text: `Error fetching image from URL: ${msg}` }],
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
    `Generate a textured 3D model (GLB) from a reference image (~1 min). Returns the file path of the generated GLB.

PREFLIGHT — check seed assets first. If the user named a specific real-world subject (e.g. "make a gb300 3D model"), call list_generated_assets BEFORE you have an image path and look for an entry whose Asset ID starts with "seed_" and whose stem matches the subject. Match case-insensitively and treat hyphens/underscores/spaces as equivalent (e.g. "gb300" matches seed_gb300, seed_GB300, seed_gb_300). If a seed image matches, pass its File path here directly — do NOT call generate_image first. Only fall through to generate_image when no seed matches and the user did not provide a path.

NOTE: This produces a single mesh, NOT a sim-ready asset. If the user asked for "sim-ready" / "physics-ready" / "articulated" / "Isaac Sim" / "USDZ for simulation", you must continue: scale_model → ground_model → segment_model → inspect_model → merge_parts → apply_part_names → export_articulation.`,
    {
      image_path: z.string().describe('Absolute file path to the reference image (PNG/JPG). Can be a path from generate_image output or any local image file.'),
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
          backend: 'reconviagen',
          seed: params.seed,
          texture_size: params.texture_size,
          ss_guidance_strength: params.ss_guidance_strength,
          ss_sampling_steps: params.ss_sampling_steps,
          slat_guidance_strength: params.slat_guidance_strength,
          slat_sampling_steps: params.slat_sampling_steps,
        });

        const lines: string[] = [
          '3D model generated successfully.',
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
    `Segment a 3D model (GLB) into individual parts. Splits a single mesh into meaningful parts (e.g. head, body, legs, arms). Takes 1-3 minutes. Returns the file path of the segmented GLB and the number of parts.

NOTE: Segmentation alone is NOT sim-ready. If the user asked for "sim-ready" / "physics-ready" / "articulated" / "Isaac Sim" / "USDZ for simulation", this is a middle step — you still need: inspect_model → merge_parts → apply_part_names → export_articulation. Do not stop after segment_model when the goal is simulation.`,
    {
      glb_path: z.string().describe('Absolute path to a GLB file to segment.'),
      point_num: z.number().int().min(1000).max(20000).optional().describe('Number of sample points (must be >= 1000; default: backend default).'),
      prompt_num: z.number().int().min(10).max(200).optional().describe('Number of prompts for segmentation (must be >= 10; default: backend default).'),
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
  // Tool: scale_model
  // -------------------------------------------------------------------------

  server.tool(
    'scale_model',
    `Uniformly scale a GLB so its bounding box matches one or more real-world physical dimensions in meters. The generate_3d output is normalised to a unit-ish bbox ([-0.5, 0.5]), which means Isaac Sim / Omniverse / any USD-aware physics consumer loads everything at the same size. Run this before export_articulation so the emitted USDZ and phidias.physics.v1 JSON are at physically accurate scale.

Only a single uniform scale factor is applied — the model's aspect ratio is preserved. Per-axis scaling would distort geometry (a wheel becoming oval) and is deliberately NOT supported.

At least one of \`width_m\` / \`height_m\` / \`depth_m\` is required. The tool does NOT guess — the caller (typically an LLM) is expected to supply the real-world size from common-sense knowledge of the object type. Example: for a standard top-freezer fridge, pass \`height_m: 1.8\`.

Pass only the dimension(s) you have strong prior knowledge about:
  • Single dim (e.g. \`{ height_m: 1.8 }\`): factor derived from that axis; other axes follow the GLB's aspect ratio. Recommended when you want to trust the generator's proportions.
  • Multiple dims: the tool computes factors from each, and uses the factor from the LARGEST target dimension (usually the "headline" size). If the implied factors disagree by more than 5 %, a warning flags aspect-ratio mismatch between the generated 3D and the real-world proportions — consider regenerating the 3D rather than silently accepting the mismatch.

Units: meters (m). Standard for OpenUSD, Isaac Sim, Omniverse, URDF, and ROS.

Returns the scaled GLB path + URL, the applied factor, original and final bbox sizes, and any warnings.`,
    {
      glb_path: z.string().describe('Absolute path to the GLB to scale.'),
      width_m: z
        .number()
        .positive()
        .optional()
        .describe('Target real-world width in meters (X axis). Optional.'),
      height_m: z
        .number()
        .positive()
        .optional()
        .describe('Target real-world height in meters (Y axis). Optional.'),
      depth_m: z
        .number()
        .positive()
        .optional()
        .describe('Target real-world depth in meters (Z axis). Optional.'),
    },
    async (params) => {
      try {
        const result = await scaleModel({
          glb_path: params.glb_path,
          width_m: params.width_m,
          height_m: params.height_m,
          depth_m: params.depth_m,
        });
        const lines: string[] = [
          'Model scaled successfully.',
          '',
          `File: ${result.output_path}`,
        ];
        const url = makeFileUrl(result.output_path);
        if (url) lines.push(`URL: ${url}`);
        lines.push(`Asset ID: ${result.asset_id}`);
        lines.push(`Applied factor: ${result.applied_factor.toFixed(4)}`);
        lines.push(
          `Original size (m): ${result.original_size_m
            .map((v) => v.toFixed(4))
            .join(' × ')}`,
        );
        lines.push(
          `Final size (m): ${result.final_size_m
            .map((v) => v.toFixed(4))
            .join(' × ')}`,
        );
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
          content: [{ type: 'text' as const, text: `Error scaling model: ${msg}` }],
          isError: true,
        };
      }
    },
  );

  // -------------------------------------------------------------------------
  // Tool: ground_model
  // -------------------------------------------------------------------------

  server.tool(
    'ground_model',
    `Translate a GLB so its bounding-box minimum Y lands on 0 (i.e. "drop the asset onto the ground plane"). Optionally also recenter the XZ axes so the object's vertical axis passes through the world origin — standard Isaac Sim / Omniverse / URDF convention: asset origin at the footprint centre, Y=0 is the floor.

Only translation is applied. Scale, rotation, and handedness are never touched — this is pure positioning so the aspect ratio and orientation chosen by the 3D generator survive unchanged.

Recommended placement in the pipeline: right after scale_model, so every subsequent step (segment_model, inspect_model, export_articulation) sees coordinates already in the grounded/centred frame. Joint anchors pulled from inspect_model bboxes are then directly usable in Isaac Sim without any post-hoc translation.

  generate_3d → scale_model → ground_model → segment_model → ...

Returns the translation applied (dx, dy, dz), original bbox, final bbox, and the new GLB path + URL.`,
    {
      glb_path: z.string().describe('Absolute path to the GLB to ground.'),
      center_xz: z
        .boolean()
        .optional()
        .describe(
          'Also recenter the XZ axes so the bbox centre lies on the world Y axis. Default true. Set false to preserve any existing XZ offset.',
        ),
    },
    async (params) => {
      try {
        const result = await groundModel({
          glb_path: params.glb_path,
          center_xz: params.center_xz,
        });
        const lines: string[] = [
          'Model grounded successfully.',
          '',
          `File: ${result.output_path}`,
        ];
        const url = makeFileUrl(result.output_path);
        if (url) lines.push(`URL: ${url}`);
        lines.push(`Asset ID: ${result.asset_id}`);
        lines.push(
          `Translation applied (dx, dy, dz): ${result.translation_applied
            .map((v) => v.toFixed(4))
            .join(', ')}`,
        );
        lines.push(
          `Original bbox: min=[${result.original_bbox.min
            .map((v) => v.toFixed(4))
            .join(', ')}] max=[${result.original_bbox.max
            .map((v) => v.toFixed(4))
            .join(', ')}]`,
        );
        lines.push(
          `Final bbox:    min=[${result.final_bbox.min
            .map((v) => v.toFixed(4))
            .join(', ')}] max=[${result.final_bbox.max
            .map((v) => v.toFixed(4))
            .join(', ')}]`,
        );
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
          content: [{ type: 'text' as const, text: `Error grounding model: ${msg}` }],
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
    `Export a physics-ready / sim-ready articulation (USDA or USDZ) from a GLB plus a description of its rigid bodies and joints. THIS IS THE SIM-READY ENDPOINT — when the user asked for a "sim-ready" / "physics-ready" / "articulated" / "Isaac Sim" / "Omniverse" asset, the pipeline must finish here, not at segment_model. This replaces what a human user would do in the Phidias Physics tab: assign materials, set mass / collision / friction per part, lay out the joint topology, and click "export".

Typical pipeline:
  segment_model → inspect_model → (optional merge_parts) → apply_part_names
                                                        → export_articulation

Node indices from inspect_model are NOT used directly here — the backend identifies parts by string \`id\`. A natural convention is to use the node name (after apply_part_names) as the id, then the joint \`parent\` / \`child\` fields reference those ids.

Every \`parts[].id\` MUST correspond to a GLB node that directly carries a mesh. Empty group nodes (produced by apply_part_names \`groups:\`) are rejected pre-flight — fuse their children with merge_parts first. The tool also re-writes the emitted phidias.physics.v1 JSON so part ids match the GLB node names, which is what the Phidias Physics Editor's MotionPreviewController uses to bind joints to meshes.

Joint limits are auto-oriented from the GLB's geometry: for each revolute / prismatic joint MCP checks whether positive motion moves the child away from or into the parent bulk, and flips \`lower_limit\` / \`upper_limit\` signs if needed so the convention "positive = opens outward" always holds. Each flip is reported as a warning. Opt out per-joint with \`auto_orient_limits: false\` if you deliberately want backward-swinging motion.

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
            center_of_mass: z.array(z.number()).length(3).nullable().optional().describe('Override the centre of mass in local coordinates. Must be a 3-element [x, y, z] array.'),
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
            axis: z.array(z.number()).length(3).optional().describe('Axis of motion in world space as a 3-element [x, y, z] array. Need not be normalised. Default [0,0,1].'),
            anchor: z.array(z.number()).length(3).optional().describe('Pivot point relative to the child body as a 3-element [x, y, z] array. Default [0,0,0] (child origin). Useful to set to the world_centroid of the joint location.'),
            lower_limit: z.number().nullable().optional().describe('Degrees for revolute, metres for prismatic. null = unlimited.'),
            upper_limit: z.number().nullable().optional(),
            drive_stiffness: z.number().min(0).nullable().optional(),
            drive_damping: z.number().min(0).nullable().optional(),
            drive_max_force: z.number().min(0).nullable().optional(),
            drive_type: z.enum(['position', 'velocity', 'none']).optional(),
            disable_collision: z.boolean().optional().describe('Disable collision between parent and child of this joint. Default true.'),
            auto_orient_limits: z
              .boolean()
              .optional()
              .describe(
                'When true (default), MCP checks geometry and flips limit signs if positive motion would go INTO the parent bulk, so "positive = opens outward" regardless of which GLB axis is the model\'s front. Set false to keep the exact signs you provided (e.g. for deliberately backward-swinging motion).',
              ),
          }),
        )
        .describe('Array of joints linking parts into a kinematic structure. Can be empty for a single rigid body.'),
      emit_physics_json: z
        .boolean()
        .optional()
        .describe(
          'If true (default), also emit a phidias.physics.v1 JSON next to the USDZ / USDA. This JSON is what the Phidias frontend Physics Editor\'s "Import Config" button accepts directly. Parsing is done in-process in TypeScript against the articulation-service\'s text USDA — no python / usdcat needed. Failures are reported as warnings and do not fail the export.',
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
  // Tool: export_for_arkit
  // -------------------------------------------------------------------------

  server.tool(
    'export_for_arkit',
    `Convert a GLB into a USDZ tailored for iOS AR Quick Look — Y-up stage, no UsdPhysics schemas, textures embedded. Use this when the consumer is an iPhone / iPad (e.g. forwarding the file via Telegram, AirDrop, iMessage; embedding in a webpage's <model-viewer ar> tag).

This is NOT the sim-ready endpoint. For Isaac Sim / Omniverse use export_articulation, which produces Z-up USDZ with full PhysicsRigidBody / PhysicsRevoluteJoint prims. AR Quick Look ignores physics anyway, and Y-up is the orientation iOS expects.

The exporter wraps the GLB as a single fixed rigid body internally (the articulation-service requires at least one part). The resulting USDZ has no joints, no PhysicsScene, no MassAPI — just textured geometry under a Y-up stage. File size ends up noticeably smaller than the equivalent Isaac USDZ for the same GLB.

Pipeline placement: typically right after generate_3d (no scale_model / segment_model / etc. needed unless you want a specific physical size in AR — ARKit honours the USD metersPerUnit, so running scale_model before this makes the model land at correct real-world scale when placed in AR).`,
    {
      glb_path: z.string().describe('Absolute path to the GLB to convert. Usually the output of generate_3d or scale_model.'),
      model_name: z.string().min(1).optional().describe('Name embedded in the USD root prim. Defaults to the GLB filename stem. Cosmetic only — does not affect AR Quick Look display.'),
    },
    async (params) => {
      try {
        const stem = path.basename(params.glb_path).replace(/\.[^.]+$/, '');
        const modelName = (params.model_name ?? stem).replace(/[^A-Za-z0-9_]/g, '_') || 'model';
        const result = await exportArticulation({
          glb_path: params.glb_path,
          model_name: modelName,
          parts: [
            {
              id: modelName,
              name: modelName,
              type: 'base',
              mobility: 'fixed',
              collision_type: 'none',
            },
          ],
          joints: [],
          format: 'usdz',
          target_platform: 'arkit',
          emit_physics_json: false,
        });

        const lines: string[] = [
          'ARKit USDZ exported successfully.',
          '',
          `File: ${result.output_path}`,
        ];
        const url = makeFileUrl(result.output_path);
        if (url) lines.push(`URL: ${url}`);
        lines.push(`Asset ID: ${result.asset_id}`);
        lines.push(`Backend filename: ${result.backend_filename}`);
        lines.push(`Source GLB: ${result.source}`);
        lines.push('', 'Drop this file into iMessage / Telegram / AirDrop on iOS — tapping it opens AR Quick Look.');
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
          content: [{ type: 'text' as const, text: `Error exporting for ARKit: ${msg}` }],
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
    `List all images and 3D models available in the current session — both generated assets AND pre-staged seed assets loaded from PHIDIAS_SEED_DIR. Shows file paths, types, prompts, and creation times. Seed entries have an Asset ID prefixed with "seed_" (the stem comes from the original filename, e.g. gb300.jpg → seed_gb300).

USE AS A PREFLIGHT before generate_image / generate_3d whenever the user names a specific real-world subject. Scan for a "seed_<subject>" Asset ID (case-insensitive, hyphens/underscores/spaces treated as equivalent); if found, pass that entry's File path straight to generate_3d and skip generate_image.`,
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

// CORS preset shared by /api/* live-stream endpoints. We allow any origin
// so a Phidias / Architect frontend served from a different host:port can
// subscribe directly. If you tighten this to a whitelist, also tighten
// the file server (otherwise the SSE event_url metadata is unreachable).
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
};

function authorize(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  token: string | undefined,
): boolean {
  if (!token) return true;
  // EventSource (browser) cannot set custom headers, so /api/* also
  // accepts ?token=<token> as a fallback. /mcp keeps the strict header
  // requirement because tool calls go through StreamableHTTP, not SSE.
  const auth = req.headers.authorization;
  if (auth === `Bearer ${token}`) return true;
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'local'}`);
  if (url.searchParams.get('token') === token) return true;
  res.writeHead(401, { 'Content-Type': 'application/json', ...CORS_HEADERS });
  res.end(
    JSON.stringify({ error: 'Unauthorized: missing or invalid bearer token' }),
  );
  return false;
}

async function startHttp(port: number, host: string, token: string | undefined): Promise<void> {
  const httpServer = http.createServer(async (req, res) => {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, CORS_HEADERS);
      res.end();
      return;
    }

    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json', ...CORS_HEADERS });
      res.end(JSON.stringify({ status: 'ok', server: 'phidias-mcp-headless' }));
      return;
    }

    // ─── Live event stream + initial state for frontends ─────────────────
    if (req.url && (req.url === '/api/session/assets' || req.url.startsWith('/api/session/assets?'))) {
      if (!authorize(req, res, token)) return;
      const publicUrlBase = buildPublicUrlBase(req);
      const assets = requestContext.run({ publicUrlBase }, () => {
        return getSessionAssets().map((a) => ({
          asset_id: a.id,
          // Prefer the fine-grained override (set by tools that produce
          // USDZ / USDA / physics_config) so the frontend snapshot matches
          // what live SSE listeners see.
          asset_type: a.assetType ?? a.type,
          file_path: a.filePath,
          file_url: makeFileUrl(a.filePath),
          source_image_path: a.sourceImagePath,
          prompt: a.prompt,
          created_at: a.createdAt,
        }));
      });
      res.writeHead(200, {
        'Content-Type': 'application/json',
        ...CORS_HEADERS,
      });
      res.end(JSON.stringify({ assets }));
      return;
    }

    if (req.url && (req.url === '/api/events/stream' || req.url.startsWith('/api/events/stream?'))) {
      if (!authorize(req, res, token)) return;
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no', // disable proxy buffering for instant push
        ...CORS_HEADERS,
      });
      res.write(': connected\n\n');

      const handler = (evt: SessionEvent) => {
        try {
          res.write(`event: ${evt.event}\n`);
          res.write(`data: ${JSON.stringify(evt)}\n\n`);
        } catch {
          // socket closed — listener is removed in 'close' handler
        }
      };
      sessionBus.on('event', handler);

      // Heartbeat every 25s so reverse proxies (and overzealous
      // network middleboxes) don't kill the idle connection.
      const ping = setInterval(() => {
        try {
          res.write(': ping\n\n');
        } catch {
          /* noop */
        }
      }, 25_000);

      req.on('close', () => {
        clearInterval(ping);
        sessionBus.off('event', handler);
      });
      return;
    }

    // ─── Image upload (raw body, avoids tool-param size limits) ──────────
    if (req.url && req.method === 'POST' && (req.url === '/api/upload' || req.url.startsWith('/api/upload?'))) {
      if (!authorize(req, res, token)) return;

      const url = new URL(req.url, `http://${req.headers.host ?? 'local'}`);
      const filename = url.searchParams.get('filename') ?? undefined;
      const note = url.searchParams.get('note') ?? undefined;

      const MAX_BYTES = 50 * 1024 * 1024;
      const chunks: Buffer[] = [];
      let received = 0;
      let aborted = false;

      req.on('data', (chunk: Buffer) => {
        if (aborted) return;
        received += chunk.length;
        if (received > MAX_BYTES) {
          aborted = true;
          res.writeHead(413, { 'Content-Type': 'application/json', ...CORS_HEADERS });
          res.end(JSON.stringify({ error: `payload too large (limit ${MAX_BYTES})` }));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });

      req.on('end', () => {
        if (aborted) return;
        try {
          const buf = Buffer.concat(chunks);
          const publicUrlBase = buildPublicUrlBase(req);
          const asset = requestContext.run({ publicUrlBase }, () =>
            saveImageBuffer(buf, {
              filename,
              note,
              tool: 'phidias.upload_image_http',
            }),
          );
          res.writeHead(200, { 'Content-Type': 'application/json', ...CORS_HEADERS });
          res.end(JSON.stringify({
            asset_id: asset.id,
            file_path: asset.filePath,
            file_url: requestContext.run({ publicUrlBase }, () => makeFileUrl(asset.filePath)),
          }));
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          res.writeHead(400, { 'Content-Type': 'application/json', ...CORS_HEADERS });
          res.end(JSON.stringify({ error: msg }));
        }
      });

      req.on('error', () => {
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json', ...CORS_HEADERS });
          res.end(JSON.stringify({ error: 'request stream error' }));
        }
      });

      return;
    }

    // File retrieval (same auth posture as /mcp)
    if (serveFileIfMatch(req, res, token)) return;

    if (!req.url || !req.url.startsWith('/mcp')) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found. MCP endpoint is at /mcp, files at /files/<name>, live stream at /api/events/stream, upload at POST /api/upload');
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
  const seedDir = process.env.PHIDIAS_SEED_DIR;
  if (seedDir && seedDir.trim().length > 0) {
    seedAssetsFromDir(seedDir.trim());
  }

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
