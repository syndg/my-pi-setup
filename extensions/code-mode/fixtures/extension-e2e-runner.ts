import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import codeModeExtension from "../index.ts";

type RegisteredTool = {
  name: string;
  execute: (
    toolCallId: string,
    parameters: { code: string },
    signal: AbortSignal,
    onUpdate: undefined,
    context: ExtensionContext,
  ) => Promise<{ content: Array<{ type: string; text?: string }> }>;
};

type EventHandler = (...arguments_: unknown[]) => unknown;

const [agentDir, cwd, encodedCode] = process.argv.slice(2);
if (!agentDir || !cwd) throw new Error("agent directory and cwd are required");
const code = encodedCode
  ? Buffer.from(encodedCode, "base64url").toString("utf8")
  : 'return await tools.test.echo({ message: "full-stack" });';
process.env.PI_CODING_AGENT_DIR = agentDir;

const tools = new Map<string, RegisteredTool>();
const handlers = new Map<string, EventHandler[]>();
const api = {
  registerTool(tool: RegisteredTool) {
    tools.set(tool.name, tool);
  },
  registerCommand() {},
  on(name: string, handler: EventHandler) {
    handlers.set(name, [...(handlers.get(name) ?? []), handler]);
  },
} as unknown as ExtensionAPI;

codeModeExtension(api);
const execute = tools.get("execute");
if (!execute) throw new Error("execute was not registered");
const context = {
  cwd,
  mode: "print",
  hasUI: false,
  isProjectTrusted: () => false,
  ui: { notify() {}, confirm: async () => false },
} as unknown as ExtensionContext;

const run = (id: string) =>
  execute.execute(
    id,
    { code },
    new AbortController().signal,
    undefined,
    context,
  );
const results =
  process.env.PI_CODE_MODE_PARALLEL_E2E === "1"
    ? await Promise.all([run("call-1"), run("call-2")])
    : [await run("call-1")];
for (const handler of handlers.get("session_shutdown") ?? []) await handler();
console.log(JSON.stringify(results.length === 1 ? results[0] : results));
if (process.env.PI_CODE_MODE_NATURAL_EXIT !== "1") process.exit(0);
