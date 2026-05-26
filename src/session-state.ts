/**
 * Frontend-pushed UI context. Lets MCP tools learn what the user is
 * currently looking at (active image in the Phidias model tab, eventually
 * selection / camera / scene state) without the caller having to repeat
 * it in every tool param.
 *
 * In-memory only; a process restart resets state. Single-tenant — the
 * same MCP process serves one frontend session at a time.
 */

import type { GeneratedAsset } from './phidias-client.js';

export interface ActiveImage {
  assetId: string;
  filePath: string;
  setAt: string;
}

interface SessionState {
  activeImage: ActiveImage | null;
}

const state: SessionState = {
  activeImage: null,
};

export function setActiveImage(asset: GeneratedAsset): void {
  state.activeImage = {
    assetId: asset.id,
    filePath: asset.filePath,
    setAt: new Date().toISOString(),
  };
}

export function clearActiveImage(): void {
  state.activeImage = null;
}

export function getActiveImage(): ActiveImage | null {
  return state.activeImage;
}
