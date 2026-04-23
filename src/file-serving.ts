// src/file-serving.ts
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { getOutputDir } from './phidias-client.js';

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.usdz': 'model/vnd.usdz+zip',
};

export function getMimeType(ext: string): string {
  return MIME_TYPES[ext.toLowerCase()] || 'application/octet-stream';
}

/**
 * Serve a file from the output directory. Returns true if handled.
 * Enforces path safety: only basename is honored, no traversal, no dotfiles.
 * If `token` is provided, requires matching Bearer header.
 */
export function serveFileIfMatch(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  token: string | undefined,
): boolean {
  if (!req.url?.startsWith('/files/')) return false;

  // CORS (match bridge.ts behavior)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return true;
  }

  if (token) {
    const auth = req.headers.authorization;
    if (auth !== `Bearer ${token}`) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized: missing or invalid bearer token' }));
      return true;
    }
  }

  let raw: string;
  try {
    raw = decodeURIComponent(req.url.slice('/files/'.length));
  } catch {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end('Bad request');
    return true;
  }
  const safeName = path.basename(raw);
  if (!safeName || safeName.startsWith('.') || safeName !== raw) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
    return true;
  }

  const filePath = path.join(getOutputDir(), safeName);
  if (!fs.existsSync(filePath)) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
    return true;
  }

  const ext = path.extname(filePath).toLowerCase();
  const stat = fs.statSync(filePath);
  res.writeHead(200, {
    'Content-Type': getMimeType(ext),
    'Content-Length': stat.size,
  });
  const stream = fs.createReadStream(filePath);
  stream.on('error', (err) => {
    process.stderr.write(`[phidias-mcp] file stream error: ${err.message}\n`);
    if (!res.headersSent) {
      res.writeHead(500);
      res.end();
    } else {
      res.destroy();
    }
  });
  stream.pipe(res);
  return true;
}
