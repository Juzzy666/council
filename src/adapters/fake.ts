/**
 * A scripted seat. Exists so the whole council — every phase, the ledger, the
 * worktrees, the integration merge — can be exercised in CI with no API key,
 * no network and no spend.
 */

import type { AgentId } from "../protocol.js";
import type { AgentAdapter, AgentRequest, AgentResult, Availability } from "./types.js";

export type FakeResponder = (request: AgentRequest, callIndex: number) => Partial<AgentResult> | string;

export class FakeAdapter implements AgentAdapter {
  readonly id: AgentId;
  readonly label: string;
  readonly calls: AgentRequest[] = [];
  readonly #responder: FakeResponder;

  constructor(id: AgentId, responder: FakeResponder, label = `fake:${id}`) {
    this.id = id;
    this.label = label;
    this.#responder = responder;
  }

  async availability(): Promise<Availability> {
    return { available: true, version: "fake", detail: "scripted seat" };
  }

  async run(request: AgentRequest): Promise<AgentResult> {
    const index = this.calls.length;
    this.calls.push(request);
    const scripted = this.#responder(request, index);
    const base: AgentResult = { ok: true, text: "", durationMs: 1, costUsd: 0 };
    if (typeof scripted === "string") {
      return { ...base, text: scripted, json: tryParse(scripted) };
    }
    const text = scripted.text ?? "";
    return {
      ...base,
      ...scripted,
      text,
      ...(scripted.json === undefined && text ? { json: tryParse(text) } : {}),
    };
  }
}

function tryParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
