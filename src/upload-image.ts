/**
 * upload_image tool — accept a base64-encoded image from the MCP caller and
 * persist it to the same OUTPUT_DIR used by generate_image, so downstream
 * tools (generate_3d, etc.) can consume the resulting filePath without any
 * code changes.
 *
 * Scope: images only (PNG / JPEG / WEBP). GLB uploads will use a different
 * mechanism (presigned PUT) once we need it — JSON-RPC base64 round-trips
 * become impractical past ~10MB.
 */

import fs from 'node:fs';
import path from 'node:path';
import { type GeneratedAsset, trackSessionAsset, getOutputDir } from './phidias-client.js';

const MAX_DECODED_BYTES = 20 * 1024 * 1024; // 20 MB safety cap

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

export interface UploadImageInput {
  image_data: string;         // base64 (with or without data: URL prefix)
  filename?: string;          // optional original filename, used for the saved name only
  note?: string;              // optional human note shown in the SSE event metadata
}

export async function uploadImage(input: UploadImageInput): Promise<GeneratedAsset> {
  if (!input.image_data || typeof input.image_data !== 'string') {
    throw new Error('image_data is required and must be a base64 string');
  }

  // Strip data: URL prefix if present
  const b64 = input.image_data.replace(/^data:image\/[a-zA-Z+.-]+;base64,/, '');

  let buf: Buffer;
  try {
    buf = Buffer.from(b64, 'base64');
  } catch {
    throw new Error('image_data is not valid base64');
  }

  if (buf.length === 0) {
    throw new Error('image_data decoded to zero bytes');
  }
  if (buf.length > MAX_DECODED_BYTES) {
    throw new Error(`image too large (${buf.length} bytes, limit ${MAX_DECODED_BYTES})`);
  }

  const sniff = sniffImage(buf);
  if (!sniff.ok) {
    throw new Error('image_data does not look like PNG, JPEG, or WEBP — unsupported format');
  }

  const stem = sanitizeStem(input.filename);
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
    tool: 'phidias.upload_image',
    name: input.filename ?? 'uploaded_image',
    metadata: {
      original_filename: input.filename,
      mime: sniff.mime,
      size_bytes: buf.length,
      note: input.note,
    },
  });

  return asset;
}
