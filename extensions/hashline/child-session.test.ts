import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";
import { EDIT_DESCRIPTION, READ_DESCRIPTION } from "./prompt.ts";

const packageDirectory = path.dirname(fileURLToPath(import.meta.url));

async function createChild(
  cwd: string,
  agentDir: string,
  options: { allowToolConflict?: boolean } = {},
) {
  const settingsManager = SettingsManager.create(cwd, agentDir, {
    projectTrusted: false,
  });
  const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager });
  await loader.reload();
  const errors = loader.getExtensions().errors;
  if (options.allowToolConflict) {
    assert.ok(
      errors.every((error) => /Tool "edit" conflicts/.test(error.error)),
    );
  } else {
    assert.deepEqual(errors, []);
  }
  const { session } = await createAgentSession({
    cwd,
    agentDir,
    settingsManager,
    resourceLoader: loader,
    sessionManager: SessionManager.inMemory(cwd),
    excludeTools: [
      "subagent_spawn",
      "subagent_wait",
      "subagent_cancel",
      "subagent_check",
      "subagent_list",
      "workflow",
      "ask_user",
    ],
  });
  await session.bindExtensions({ mode: "print" });
  return session;
}

async function execute(
  session: AgentSession,
  name: "read" | "edit",
  params: unknown,
) {
  const tool = session.getToolDefinition(name);
  assert.ok(tool, `${name} should be present`);
  return Reflect.apply(tool.execute, tool, [
    "child-call",
    params,
    undefined,
    undefined,
    { cwd: session.sessionManager.getCwd(), model: undefined },
  ]);
}

function resultText(result: unknown) {
  assert.ok(result && typeof result === "object" && "content" in result);
  const content = result.content;
  assert.ok(Array.isArray(content));
  const part = content[0];
  assert.ok(
    part && typeof part === "object" && "type" in part && part.type === "text",
  );
  assert.ok("text" in part && typeof part.text === "string");
  return part.text;
}

test("split override ownership disables both active protocol tools", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "hashline-ownership-"));
  const agentDir = path.join(directory, "agent");
  try {
    await mkdir(path.join(agentDir, "extensions"), { recursive: true });
    await writeFile(
      path.join(agentDir, "settings.json"),
      JSON.stringify({ packages: [packageDirectory] }),
    );
    await writeFile(
      path.join(agentDir, "extensions", "zz-split.ts"),
      `import { Type } from "typebox";
export default function (pi) {
  pi.registerTool({
    name: "edit",
    label: "edit",
    description: ${JSON.stringify(EDIT_DESCRIPTION)},
    parameters: Type.Object({}),
    async execute() { return { content: [{ type: "text", text: "wrong owner" }] }; },
  });
}
`,
    );
    const child = await createChild(directory, agentDir, {
      allowToolConflict: true,
    });
    try {
      const active = new Set(child.getActiveToolNames());
      assert.equal(active.has("read"), false);
      assert.equal(active.has("edit"), false);
      const sources = child
        .getAllTools()
        .filter((tool) => tool.name === "read" || tool.name === "edit")
        .map((tool) => tool.sourceInfo.path);
      assert.equal(new Set(sources).size, 2);
    } finally {
      child.dispose();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("half-active paired ownership disables the remaining active tool", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "hashline-activation-"));
  const agentDir = path.join(directory, "agent");
  try {
    await mkdir(path.join(agentDir, "extensions"), { recursive: true });
    await writeFile(
      path.join(agentDir, "settings.json"),
      JSON.stringify({ packages: [packageDirectory] }),
    );
    await writeFile(
      path.join(agentDir, "extensions", "aa-half-active.ts"),
      `export default function (pi) {
  pi.on("session_start", () => {
    pi.setActiveTools(pi.getActiveTools().filter((name) => name !== "edit"));
  });
}
`,
    );
    const child = await createChild(directory, agentDir);
    try {
      const active = new Set(child.getActiveToolNames());
      assert.equal(active.has("read"), false);
      assert.equal(active.has("edit"), false);
    } finally {
      child.dispose();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Pi child inventory receives paired overrides and each child has isolated snapshots", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "hashline-child-"));
  const agentDir = path.join(directory, "agent");
  try {
    await writeFile(path.join(directory, "a.txt"), "one\ntwo\n");
    await mkdir(agentDir, { recursive: true });
    await writeFile(
      path.join(agentDir, "settings.json"),
      JSON.stringify({ packages: [packageDirectory] }),
    );
    const first = await createChild(directory, agentDir);
    const second = await createChild(directory, agentDir);
    try {
      for (const child of [first, second]) {
        const active = new Set(child.getActiveToolNames());
        assert.equal(active.has("read"), true);
        assert.equal(active.has("edit"), true);
        assert.equal(active.has("ask_user"), false);
        for (const firecrawlTool of ["search", "crawl", "scrape"]) {
          assert.equal(active.has(firecrawlTool), false);
          assert.equal(child.getToolDefinition(firecrawlTool), undefined);
        }
        assert.equal(
          child.getToolDefinition("read")?.description,
          READ_DESCRIPTION,
        );
        assert.equal(
          child.getToolDefinition("edit")?.description,
          EDIT_DESCRIPTION,
        );
        const readSource = child
          .getAllTools()
          .find((tool) => tool.name === "read")?.sourceInfo;
        const editSource = child
          .getAllTools()
          .find((tool) => tool.name === "edit")?.sourceInfo;
        assert.equal(readSource?.path, editSource?.path);
        assert.match(readSource?.path ?? "", /hashline\/index\.ts$/);
        assert.match(
          child.systemPrompt,
          /original line numbers from a Hashline read/,
        );
        assert.match(
          child.systemPrompt,
          /re-ground from its fresh \[path#TAG\]/,
        );
        assert.doesNotMatch(
          child.systemPrompt,
          /oldText|exact text replacement/,
        );
      }

      const readResult = await execute(first, "read", { path: "a.txt" });
      const tag = resultText(readResult).match(/#([0-9A-F]{16})/)?.[1];
      assert.ok(tag);
      await assert.rejects(
        execute(second, "edit", {
          path: "a.txt",
          tag,
          operations: [{ op: "replace", start: 1, end: 1, lines: ["ONE"] }],
        }),
        /Unrecognized snapshot/,
      );

      await first.extensionRunner.emit({
        type: "session_shutdown",
        reason: "reload",
      });
      await first.extensionRunner.emit({
        type: "session_start",
        reason: "reload",
      });
      await assert.rejects(
        execute(first, "edit", {
          path: "a.txt",
          tag,
          operations: [{ op: "replace", start: 1, end: 1, lines: ["ONE"] }],
        }),
        /Unrecognized snapshot/,
      );
    } finally {
      first.dispose();
      second.dispose();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
