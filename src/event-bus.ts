/**
 * In-process event bus for live streaming of MCP activity to subscribed
 * frontends (Phidias UI, Architect UI, anything that opens an SSE
 * connection to /api/events/stream).
 *
 * Scope is intentionally narrow: pure Node EventEmitter, no persistence,
 * no cross-process broadcast. When the MCP process restarts, history is
 * gone — that's fine for a "live mirror" use case. If we ever need
 * durable / cross-tool fan-out, this whole module is replaced by a POST
 * to a real Asset Management service.
 */

import { EventEmitter } from 'node:events';

export type AssetType = 'image' | 'model' | 'usdz' | 'usda' | 'physics_config';

export interface AssetCreatedEvent {
  event: 'asset.created';
  asset_id: string;
  asset_type: AssetType;
  name: string;
  file_url: string | null;        // null in stdio-only mode (no public URL)
  file_path: string;              // always present, MCP-local path
  source_asset_id?: string;       // chain back to the upstream asset (image → model → scaled → grounded …)
  tool: string;                   // e.g. "phidias.generate_3d"
  metadata?: Record<string, unknown>;
  timestamp: string;
}

export interface StepStartedEvent {
  event: 'step.started';
  tool: string;
  params_summary?: string;        // short human-readable hint
  timestamp: string;
}

export interface StepCompletedEvent {
  event: 'step.completed';
  tool: string;
  ok: boolean;
  message?: string;
  timestamp: string;
}

export type SessionEvent =
  | AssetCreatedEvent
  | StepStartedEvent
  | StepCompletedEvent;

class SessionBus extends EventEmitter {
  emitEvent(evt: SessionEvent): void {
    // Single channel, frontends filter by `event` field client-side.
    this.emit('event', evt);
  }
}

// Module-level singleton so all tool modules share one bus per process.
export const sessionBus = new SessionBus();
// Bump max listeners so multiple frontend SSE connections don't trigger
// Node's default warning at 11 listeners.
sessionBus.setMaxListeners(0);
