import assert from "node:assert/strict";
import test from "node:test";
import workflowsExtension from "./index.ts";
import { activateWorkflowTool, branchHasWorkflowActivation, initializeWorkflowTool, shouldActivateWorkflow, WORKFLOW_ACTIVATION_ENTRY } from "./activation.ts";

test("workflow trigger matches only ultracode or explicit requests", () => {
  for (const text of ["ultracode this", "Please run a workflow for this", "I want a workflow run", "orchestrate this with a workflow"]) assert.equal(shouldActivateWorkflow(text), true, text);
  for (const text of ["Explain workflow concepts", "Do not run a workflow", "workflows/index.ts", "no workflow please"]) assert.equal(shouldActivateWorkflow(text), false, text);
});

test("workflow activation is additive and remains active", () => {
  let active = ["read", "bash"];
  const entries: string[] = [];
  const api = { getActiveTools: () => [...active], setActiveTools: (names: string[]) => { active = names; }, appendEntry: (type: string) => { entries.push(type); } };
  initializeWorkflowTool(api, false);
  assert.deepEqual(active, ["read", "bash"]);
  assert.equal(activateWorkflowTool(api), true);
  assert.deepEqual(active, ["read", "bash", "workflow"]);
  assert.equal(activateWorkflowTool(api), false);
  assert.equal(entries.length, 1);
});

test("activation restoration sees non-context entries across branches", () => {
  assert.equal(branchHasWorkflowActivation([{ type: "custom", customType: WORKFLOW_ACTIVATION_ENTRY }]), true);
});

test("one extension instance resets activation between sessions and restores resumed sessions", () => {
  type Handler = (event: unknown, ctx: unknown) => unknown;
  const handlers = new Map<string, Handler[]>();
  let active = ["read", "workflow"];
  let entries: readonly unknown[] = [];
  const pi = {
    on: (name: string, handler: Handler) => {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    },
    registerTool: () => {},
    registerCommand: () => {},
    getActiveTools: () => [...active],
    setActiveTools: (names: string[]) => { active = names; },
    appendEntry: () => {},
  };
  workflowsExtension(pi as never);
  const ctx = {
    hasUI: false,
    sessionManager: { getEntries: () => entries },
  };
  const emit = (name: "session_start" | "session_tree") => {
    for (const handler of handlers.get(name) ?? []) handler({}, ctx);
  };

  entries = [{ type: "custom", customType: WORKFLOW_ACTIVATION_ENTRY }];
  emit("session_start");
  assert.deepEqual(active, ["read", "workflow"]);

  entries = [];
  emit("session_tree");
  assert.deepEqual(active, ["read", "workflow"]);

  emit("session_start");
  assert.deepEqual(active, ["read"]);

  entries = [{ type: "message", message: { role: "toolResult", toolName: "workflow" } }];
  emit("session_start");
  assert.deepEqual(active, ["read", "workflow"]);
});
