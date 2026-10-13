/** Builds a seat from config. Kept separate so the MCP server can construct a
 * peer without importing the engine (and the engine without importing the
 * server). */

import { CLAUDE, MUSE, type AgentId } from "../protocol.js";
import type { CouncilConfig } from "../config.js";
import type { AgentAdapter } from "./types.js";
import { ClaudeCodeAdapter } from "./claude-code.js";
import { MuseCodeAdapter } from "./muse-code.js";

export function createSeat(id: AgentId, config: CouncilConfig): AgentAdapter | null {
  if (id === CLAUDE) return new ClaudeCodeAdapter(config.seats.claude);
  if (id === MUSE) return new MuseCodeAdapter(config.seats.muse);
  return null;
}

export function createSeats(config: CouncilConfig): AgentAdapter[] {
  const seats: AgentAdapter[] = [];
  if (config.seats.claude.enabled) seats.push(new ClaudeCodeAdapter(config.seats.claude));
  if (config.seats.muse.enabled) seats.push(new MuseCodeAdapter(config.seats.muse));
  return seats;
}
