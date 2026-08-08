import assert from "node:assert/strict";
import test from "node:test";
import subagentsExtension from "./index.ts";
import {
  activateSubagentTools,
  branchHasActivation,
  initializeSubagentTools,
  SUBAGENT_ACTIVATION_ENTRY,
  SUBAGENT_CONTROL_TOOL_NAMES,
} from "./src/tool-activation.ts";

test("subagent controls start deferred, activate additively, and stay active", () => {
  let active = ["read", "subagent_spawn", ...SUBAGENT_CONTROL_TOOL_NAMES];
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
  initializeSubagentTools(api, false);
  assert.deepEqual(active, ["read", "subagent_spawn"]);
  assert.equal(activateSubagentTools(api), true);
  assert.deepEqual(active, [
    "read",
    "subagent_spawn",
    ...SUBAGENT_CONTROL_TOOL_NAMES,
  ]);
  assert.equal(activateSubagentTools(api), false);
  assert.equal(persisted, 1);
});

test("activation restoration scans non-context entries from every branch", () => {
  const offBranch = [{ type: "custom", customType: SUBAGENT_ACTIVATION_ENTRY }];
  assert.equal(branchHasActivation(offBranch), true);
  assert.equal(branchHasActivation([]), false);
});

test("one extension instance resets activation between sessions and restores resumed sessions", () => {
  type Handler = (event: unknown, ctx: unknown) => unknown;
  const handlers = new Map<string, Handler[]>();
  let active = ["read", "subagent_spawn", ...SUBAGENT_CONTROL_TOOL_NAMES];
  let harnessOptions: readonly string[] | undefined;
  let entries: readonly unknown[] = [];
  const pi = {
    events: { on: () => () => {} },
    on: (name: string, handler: Handler) => {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    },
    registerTool: (tool: {
      name: string;
      parameters?: { properties?: { harness?: { enum?: readonly string[] } } };
    }) => {
      if (tool.name === "subagent_spawn") {
        harnessOptions = tool.parameters?.properties?.harness?.enum;
      }
    },
    registerMessageRenderer: () => {},
    registerEntryRenderer: () => {},
    registerCommand: () => {},
    getActiveTools: () => [...active],
    setActiveTools: (names: string[]) => {
      active = names;
    },
    appendEntry: () => {},
  };
  subagentsExtension(pi as never);
  assert.deepEqual(harnessOptions, ["pi"]);
  const ctx = {
    hasUI: false,
    sessionManager: { getEntries: () => entries },
  };
  const emit = (name: "session_start" | "session_tree") => {
    for (const handler of handlers.get(name) ?? []) handler({}, ctx);
  };

  entries = [{ type: "custom", customType: SUBAGENT_ACTIVATION_ENTRY }];
  emit("session_start");
  assert.deepEqual(active, [
    "read",
    "subagent_spawn",
    ...SUBAGENT_CONTROL_TOOL_NAMES,
  ]);

  entries = [];
  emit("session_tree");
  assert.deepEqual(active, [
    "read",
    "subagent_spawn",
    ...SUBAGENT_CONTROL_TOOL_NAMES,
  ]);

  emit("session_start");
  assert.deepEqual(active, ["read", "subagent_spawn"]);

  entries = [
    {
      type: "message",
      message: { role: "toolResult", toolName: "subagent_spawn" },
    },
  ];
  emit("session_start");
  assert.deepEqual(active, [
    "read",
    "subagent_spawn",
    ...SUBAGENT_CONTROL_TOOL_NAMES,
  ]);
});
