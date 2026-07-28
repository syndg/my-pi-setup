import assert from "node:assert/strict";
import test from "node:test";
import backgroundTerminalsExtension from "./index.ts";
import {
  activateBgTools,
  BG_ACTIVATION_ENTRY,
  BG_CONTROL_TOOL_NAMES,
  branchHasBgActivation,
  initializeBgTools,
} from "./src/tool-activation.ts";

test("terminal controls activate only after start and persist additively", () => {
  let active = ["read", "bg_start", ...BG_CONTROL_TOOL_NAMES];
  let persisted = 0;
  const api = {
    getActiveTools: () => [...active],
    setActiveTools: (names: string[]) => {
      active = names;
    },
    appendEntry: () => {
      persisted++;
    },
  };
  initializeBgTools(api, false);
  assert.deepEqual(active, ["read", "bg_start"]);
  assert.equal(activateBgTools(api), true);
  assert.deepEqual(active, ["read", "bg_start", ...BG_CONTROL_TOOL_NAMES]);
  assert.equal(activateBgTools(api), false);
  assert.equal(persisted, 1);
});

test("activation restoration sees an off-branch session entry", () => {
  assert.equal(
    branchHasBgActivation([
      { type: "custom", customType: BG_ACTIVATION_ENTRY },
    ]),
    true,
  );
});

test("one extension instance resets activation between sessions and restores resumed sessions", () => {
  type Handler = (event: unknown, ctx: unknown) => unknown;
  const handlers = new Map<string, Handler[]>();
  let active = ["read", "bg_start", ...BG_CONTROL_TOOL_NAMES];
  let entries: readonly unknown[] = [];
  const pi = {
    events: { on: () => () => {} },
    on: (name: string, handler: Handler) => {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    },
    registerTool: () => {},
    registerMessageRenderer: () => {},
    registerCommand: () => {},
    getActiveTools: () => [...active],
    setActiveTools: (names: string[]) => {
      active = names;
    },
    appendEntry: () => {},
  };
  backgroundTerminalsExtension(pi as never);
  const ctx = {
    hasUI: false,
    sessionManager: { getEntries: () => entries },
  };
  const emit = (name: "session_start" | "session_tree") => {
    for (const handler of handlers.get(name) ?? []) handler({}, ctx);
  };

  entries = [{ type: "custom", customType: BG_ACTIVATION_ENTRY }];
  emit("session_start");
  assert.deepEqual(active, ["read", "bg_start", ...BG_CONTROL_TOOL_NAMES]);

  entries = [];
  emit("session_tree");
  assert.deepEqual(active, ["read", "bg_start", ...BG_CONTROL_TOOL_NAMES]);

  emit("session_start");
  assert.deepEqual(active, ["read", "bg_start"]);

  entries = [
    { type: "message", message: { role: "toolResult", toolName: "bg_start" } },
  ];
  emit("session_start");
  assert.deepEqual(active, ["read", "bg_start", ...BG_CONTROL_TOOL_NAMES]);
});
