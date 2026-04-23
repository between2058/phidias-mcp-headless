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
