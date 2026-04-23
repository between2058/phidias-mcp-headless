// src/request-context.ts
import { AsyncLocalStorage } from 'node:async_hooks';
import path from 'node:path';
import type http from 'node:http';

export interface RequestContext {
  publicUrlBase: string; // e.g. "http://172.18.245.177:7777"
}

export const requestContext = new AsyncLocalStorage<RequestContext>();

export function buildPublicUrlBase(req: http.IncomingMessage): string {
  const host = req.headers.host ?? 'localhost';
  const proto = (req.headers['x-forwarded-proto'] as string | undefined) ?? 'http';
  return `${proto}://${host}`;
}

/**
 * Build a public URL for a file in the output directory, using the current
 * HTTP request's Host header. Returns null in stdio mode (no request context).
 */
export function makeFileUrl(filePath: string): string | null {
  const ctx = requestContext.getStore();
  if (!ctx) return null;
  const fileName = path.basename(filePath);
  return `${ctx.publicUrlBase}/files/${encodeURIComponent(fileName)}`;
}
