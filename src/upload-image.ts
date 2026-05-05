/**
 * Image upload helper — used by the HTTP POST /api/upload endpoint to
 * persist a user-supplied image into OUTPUT_DIR with the same id format
 * and SSE event broadcast as generate_image, so downstream tools
 * (generate_3d, etc.) consume the file path unchanged.
 *
 * Scope: images only (PNG / JPEG / WEBP). GLB uploads will reuse the same
 * endpoint with a different validator once we need it.
 *
 * The MCP `upload_image` tool is a redirector — it returns the curl recipe
 * for the agent to run, since image bytes can't fit reliably through
 * MCP tool parameters.
 */

import fs from 'node:fs';
import path from 'node:path';
import { type GeneratedAsset, trackSessionAsset, getOutputDir } from './phidias-client.js';

const MAX_DECODED_BYTES = 50 * 1024 * 1024; // 50 MB upper bound for raw-stream uploads

interface ImageSniffResult {
  ok: boolean;
  ext: string;        // canonical extension without dot
  mime: string;
}

function sniffImage(buf: Buffer): ImageSniffResult {
  if (buf.length >= 8 &&
      buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return { ok: true, ext: 'png', mime: 'image/png' };
  }
  if (buf.length >= 3 &&
      buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return { ok: true, ext: 'jpg', mime: 'image/jpeg' };
  }
  if (buf.length >= 12 &&
      buf.toString('ascii', 0, 4) === 'RIFF' &&
      buf.toString('ascii', 8, 12) === 'WEBP') {
    return { ok: true, ext: 'webp', mime: 'image/webp' };
  }
  return { ok: false, ext: '', mime: '' };
}

function sanitizeStem(raw: string | undefined): string {
  if (!raw) return 'upload';
  const base = path.basename(raw);
  const stem = base.replace(/\.[^.]+$/, '');
  const cleaned = stem.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 60);
  return cleaned || 'upload';
}

export interface SaveImageOptions {
  filename?: string;
  note?: string;
  tool: string;       // e.g. 'phidias.upload_image' or 'phidias.upload_http'
}

/**
 * Validate, persist, and track an image buffer. Shared by the MCP tool and
 * the HTTP /api/upload endpoint.
 */
export function saveImageBuffer(buf: Buffer, opts: SaveImageOptions): GeneratedAsset {
  if (buf.length === 0) {
    throw new Error('image buffer is empty');
  }
  if (buf.length > MAX_DECODED_BYTES) {
    throw new Error(`image too large (${buf.length} bytes, limit ${MAX_DECODED_BYTES})`);
  }

  const sniff = sniffImage(buf);
  if (!sniff.ok) {
    throw new Error('payload does not look like PNG, JPEG, or WEBP — unsupported format');
  }

  const stem = sanitizeStem(opts.filename);
  const ts = Date.now();
  const outName = `img_${ts}_upload_${stem}.${sniff.ext}`;
  const outPath = path.join(getOutputDir(), outName);
  fs.writeFileSync(outPath, buf);

  const asset: GeneratedAsset = {
    id: `img_${ts}`,
    type: 'image',
    filePath: outPath,
    createdAt: new Date().toISOString(),
  };

  trackSessionAsset(asset, {
    tool: opts.tool,
    name: opts.filename ?? 'uploaded_image',
    metadata: {
      original_filename: opts.filename,
      mime: sniff.mime,
      size_bytes: buf.length,
      note: opts.note,
    },
  });

  return asset;
}

