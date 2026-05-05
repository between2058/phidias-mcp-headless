/**
 * upload_image tool — accept an image supplied by the MCP caller and persist
 * it to the same OUTPUT_DIR used by generate_image, so downstream tools
 * (generate_3d, etc.) can consume the resulting filePath without any code
 * changes.
 *
 * Two intake paths share `saveImageBuffer`:
 *
 *  1. MCP tool: agent passes base64 string (small images only, see warning
 *     below).
 *  2. HTTP POST /api/upload: agent streams raw bytes via `curl --data-binary`.
 *     This avoids the Bash-output truncation that breaks any non-trivial
 *     image when going through the MCP tool param path.
 *
 * Scope: images only (PNG / JPEG / WEBP). GLB uploads will use the same
 * /api/upload endpoint with a different validator once we need it.
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

// ---------------------------------------------------------------------------
// MCP tool entry point: base64 in tool param.
//
// WARNING: Claude Code's Bash tool truncates command output well below 1 MB,
// so a workflow like `Bash("base64 < photo.png")` → tool param will silently
// corrupt anything beyond ~kilobytes. For real uploads, agents should use
// the HTTP /api/upload endpoint via curl. This tool is kept only as a
// fallback for tiny images already in the agent's context.
// ---------------------------------------------------------------------------

export interface UploadImageInput {
  image_data: string;
  filename?: string;
  note?: string;
}

export async function uploadImage(input: UploadImageInput): Promise<GeneratedAsset> {
  if (!input.image_data || typeof input.image_data !== 'string') {
    throw new Error('image_data is required and must be a base64 string');
  }

  const b64 = input.image_data.replace(/^data:image\/[a-zA-Z+.-]+;base64,/, '');

  let buf: Buffer;
  try {
    buf = Buffer.from(b64, 'base64');
  } catch {
    throw new Error('image_data is not valid base64');
  }

  return saveImageBuffer(buf, {
    filename: input.filename,
    note: input.note,
    tool: 'phidias.upload_image',
  });
}
