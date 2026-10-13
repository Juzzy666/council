import { test } from "node:test";
import assert from "node:assert/strict";
import { extractJsonObject } from "../src/json.js";
import { parseLastJsonObject, uuidFromKey } from "../src/adapters/claude-code.js";

test("parses a bare object", () => {
  assert.deepEqual(extractJsonObject('{"a":1}'), { a: 1 });
});

test("parses a fenced object with a preamble", () => {
  const reply = "Here is my plan:\n\n```json\n{\"summary\":\"hi\"}\n```\nHope that helps.";
  assert.deepEqual(extractJsonObject(reply), { summary: "hi" });
});

test("survives braces and quotes inside strings", () => {
  const reply = 'Sure: {"detail":"use {a: 1} and a \\"quote\\"","ok":true} done';
  assert.deepEqual(extractJsonObject(reply), { detail: 'use {a: 1} and a "quote"', ok: true });
});

test("returns undefined when there is no JSON at all", () => {
  assert.equal(extractJsonObject("I could not do that."), undefined);
  assert.equal(extractJsonObject(""), undefined);
});

test("the last JSON line wins, so a warning line is ignored", () => {
  const stdout = 'warning: something\n{"type":"result","result":"ok"}\n';
  assert.deepEqual(parseLastJsonObject(stdout), { type: "result", result: "ok" });
});

test("a pretty-printed object spanning lines still parses", () => {
  assert.deepEqual(parseLastJsonObject('{\n  "a": 1\n}'), { a: 1 });
});

test("a session key becomes a valid, stable UUID", () => {
  const id = uuidFromKey("t_abc-claude");
  // claude --session-id rejects anything that is not a UUID.
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(id, uuidFromKey("t_abc-claude"), "the same key must resume the same session");
  assert.notEqual(id, uuidFromKey("t_abc-muse"), "different seats must not share a session");
});
