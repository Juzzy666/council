/** Public surface: everything needed to embed a council in another program. */

export { Council, defaultMcpServerPath, coercePlan } from "./council.js";
export type { BriefInput, CouncilOptions } from "./council.js";
export { loadConfig, seatIds, DEFAULT_CONFIG, CONFIG_FILENAME } from "./config.js";
export type {
  ClaudeSeatConfig,
  CouncilConfig,
  MuseAppConfig,
  MuseSeatConfig,
} from "./config.js";
export { Ledger, ledgerPath, foldTask, hashOf, canonicalize, GENESIS_HASH } from "./ledger.js";
export { ClaudeCodeAdapter, runProcess, parseLastJsonObject } from "./adapters/claude-code.js";
export { MuseCodeAdapter, writeMuseSettings } from "./adapters/muse-code.js";
export { MuseAppLane } from "./adapters/muse-app.js";
export { FakeAdapter } from "./adapters/fake.js";
export type { FakeResponder } from "./adapters/fake.js";
export { createSeat, createSeats } from "./adapters/factory.js";
export type {
  AgentAdapter,
  AgentRequest,
  AgentResult,
  Availability,
  McpWiring,
} from "./adapters/types.js";
export {
  assignUnits,
  dedupeCandidates,
  hasBlockers,
  planHash,
  resolveConvergence,
  toCandidate,
} from "./consensus.js";
export type { Candidate, Convergence } from "./consensus.js";
export { detectChecks, runCheck, runChecks, allPassed } from "./checks.js";
export * as git from "./git.js";
export { extractJsonObject } from "./json.js";
export * from "./protocol.js";
