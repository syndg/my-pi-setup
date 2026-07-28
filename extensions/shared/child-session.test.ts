import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import test from "node:test";
import {
  createAgentSession,
  DefaultResourceLoader,
  defineTool,
  ProjectTrustStore,
  SessionManager,
  SettingsManager,
  type SessionShutdownEvent,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  bindChildSessionExtensions,
  CHILD_FORBIDDEN_TOOL_NAMES,
  CHILD_TOOL_PROFILE_NAMES,
  childToolPolicy,
  createChildResources,
  resolveStandaloneChildProjectTrust,
  shutdownAndDisposeChildSession,
  type DisposableChildSession,
} from "./child-session.ts";
async function withTempDir(run: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(path.join(tmpdir(), "pi-child-policy-"));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("child profiles are explicit and preserve required safety tools", async () => {
  assert.deepEqual(
    [...CHILD_TOOL_PROFILE_NAMES],
    ["research", "coding", "review", "minimal"],
  );
  const coding = childToolPolicy("coding", [
    "message_orchestrator",
    "workflow",
  ]);
  assert.equal(coding.tools.includes("read"), true);
  assert.equal(coding.tools.includes("edit"), true);
  assert.equal(coding.tools.includes("write"), true);
  assert.equal(coding.tools.includes("message_orchestrator"), true);
  assert.equal(coding.tools.includes("workflow"), false);
  assert.deepEqual(coding.excludeTools, [...CHILD_FORBIDDEN_TOOL_NAMES]);

  const research = childToolPolicy("research");
  assert.equal(research.tools.includes("mcp"), true);
  assert.equal(research.tools.includes("edit"), false);
  assert.equal(research.tools.includes("write"), false);
  const review = childToolPolicy("review");
  assert.equal(review.tools.includes("mcp"), false);
  assert.equal(review.tools.includes("edit"), false);
  assert.deepEqual(childToolPolicy("minimal").tools, ["read"]);
});

test("child allowlist keeps structured output active and orchestration denied", async () => {
  await withTempDir(async (directory) => {
    const settingsManager = SettingsManager.inMemory(undefined, {
      projectTrusted: false,
    });
    const inlineLoader = new DefaultResourceLoader({
      cwd: directory,
      agentDir: path.join(directory, "inline-agent"),
      settingsManager,
      extensionFactories: [
        (pi) => {
          for (const name of [
            "fixture_extension_tool",
            ...CHILD_FORBIDDEN_TOOL_NAMES,
          ]) {
            pi.registerTool({
              name,
              label: name,
              description: name,
              parameters: Type.Object({}),
              async execute() {
                return { content: [{ type: "text", text: "ok" }], details: {} };
              },
            });
          }
        },
      ],
    });
    await inlineLoader.reload();
    const structuredOutput = defineTool({
      name: "structured_output",
      label: "Structured Output",
      description: "fixture",
      parameters: Type.Object({ value: Type.String() }),
      async execute(_id, params) {
        return { content: [{ type: "text", text: params.value }], details: {} };
      },
    });
    const { session } = await createAgentSession({
      cwd: directory,
      resourceLoader: inlineLoader,
      settingsManager,
      sessionManager: SessionManager.inMemory(directory),
      customTools: [structuredOutput],
      ...childToolPolicy("research", ["structured_output"]),
    });
    await bindChildSessionExtensions(session);
    const active = new Set(session.getActiveToolNames());
    for (const required of ["read", "bash", "structured_output"])
      assert.equal(active.has(required), true);
    for (const denied of CHILD_FORBIDDEN_TOOL_NAMES)
      assert.equal(active.has(denied), false);
    assert.equal(active.has("edit"), false);
    assert.equal(active.has("fixture_extension_tool"), false);
    await shutdownAndDisposeChildSession(session);
  });
});

test("resource loading gates project extensions but retains global extensions", async () => {
  await withTempDir(async (directory) => {
    const cwd = path.join(directory, "project");
    const agentDir = path.join(directory, "agent");
    await mkdir(path.join(cwd, ".pi", "extensions"), { recursive: true });
    await mkdir(path.join(agentDir, "extensions"), { recursive: true });
    const extensionSource = (name: string) => `
      export default function (pi) {
        pi.registerTool({
          name: ${JSON.stringify(name)}, label: ${JSON.stringify(name)},
          description: "fixture", parameters: { type: "object", properties: {} },
          async execute() { return { content: [{ type: "text", text: "ok" }] }; }
        });
      }
    `;
    await writeFile(
      path.join(agentDir, "extensions", "global.ts"),
      extensionSource("global_fixture"),
    );
    await writeFile(
      path.join(cwd, ".pi", "extensions", "project.ts"),
      extensionSource("project_fixture"),
    );

    const untrusted = await createChildResources({
      cwd,
      agentDir,
      projectTrusted: false,
    });
    const untrustedTools = untrusted.loader
      .getExtensions()
      .extensions.flatMap((extension) => [...extension.tools.keys()]);
    assert.equal(untrustedTools.includes("global_fixture"), true);
    assert.equal(untrustedTools.includes("project_fixture"), false);

    const trusted = await createChildResources({
      cwd,
      agentDir,
      projectTrusted: true,
    });
    const trustedTools = trusted.loader
      .getExtensions()
      .extensions.flatMap((extension) => [...extension.tools.keys()]);
    assert.equal(trustedTools.includes("global_fixture"), true);
    assert.equal(trustedTools.includes("project_fixture"), true);
  });
});

test("alternate standalone cwd only uses explicit saved trust", async () => {
  await withTempDir(async (directory) => {
    const parentCwd = path.join(directory, "parent");
    const childCwd = path.join(directory, "alternate");
    const agentDir = path.join(directory, "agent");
    await mkdir(parentCwd, { recursive: true });
    await mkdir(childCwd, { recursive: true });

    assert.equal(
      resolveStandaloneChildProjectTrust({
        parentCwd,
        childCwd: parentCwd,
        parentTrusted: true,
        agentDir,
      }),
      true,
    );
    assert.equal(
      resolveStandaloneChildProjectTrust({
        parentCwd,
        childCwd,
        parentTrusted: true,
        agentDir,
      }),
      false,
    );

    new ProjectTrustStore(agentDir).set(childCwd, true);
    assert.equal(
      resolveStandaloneChildProjectTrust({
        parentCwd,
        childCwd,
        parentTrusted: false,
        agentDir,
      }),
      true,
    );
  });
});

test("shutdown helper balances hooks and disposal despite errors", async () => {
  let emits = 0;
  let disposals = 0;
  const session: DisposableChildSession = {
    extensionRunner: {
      hasHandlers: () => true,
      async emit(event: SessionShutdownEvent) {
        emits++;
        assert.deepEqual(event, { type: "session_shutdown", reason: "quit" });
        throw new Error("fixture shutdown failure");
      },
    },
    dispose() {
      disposals++;
    },
  };

  await Promise.all([
    shutdownAndDisposeChildSession(session),
    shutdownAndDisposeChildSession(session),
    shutdownAndDisposeChildSession(session),
  ]);
  assert.equal(emits, 1);
  assert.equal(disposals, 1);
});

test("shutdown helper bounds a stuck hook before disposal", async () => {
  let disposals = 0;
  const session: DisposableChildSession = {
    extensionRunner: {
      hasHandlers: () => true,
      emit: () => new Promise(() => {}),
    },
    dispose() {
      disposals++;
    },
  };

  await shutdownAndDisposeChildSession(session, { timeoutMs: 10 });
  assert.equal(disposals, 1);
});
