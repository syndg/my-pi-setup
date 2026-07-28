import assert from "node:assert/strict";
import test from "node:test";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  CONTEXT_GOVERNOR_CHANNEL,
  emptyGovernorState,
} from "../shared/context-governor-state.ts";
import uiCustomization from "./index.ts";

type EventHandler = (
  event: unknown,
  ctx: ExtensionContext,
) => unknown | Promise<unknown>;

type FooterFactory = (
  tui: { requestRender(): void },
  theme: { fg(color: string, text: string): string },
  footerData: {
    getGitBranch(): string | null;
    getExtensionStatuses(): ReadonlyMap<string, string>;
    onBranchChange(listener: () => void): () => void;
  },
) => { render(width: number): string[]; invalidate(): void };

class FakePi {
  readonly handlers = new Map<string, EventHandler[]>();
  private readonly bus = new Map<string, Set<(value: unknown) => void>>();

  readonly events = {
    on: (channel: string, handler: (value: unknown) => void) => {
      const handlers = this.bus.get(channel) ?? new Set();
      handlers.add(handler);
      this.bus.set(channel, handlers);
      return () => handlers.delete(handler);
    },
    emit: (channel: string, value: unknown) => {
      for (const handler of this.bus.get(channel) ?? []) handler(value);
    },
  };

  on(name: string, handler: unknown) {
    const handlers = this.handlers.get(name) ?? [];
    handlers.push(handler as EventHandler);
    this.handlers.set(name, handlers);
  }

  async emit(name: string, event: unknown, ctx: ExtensionContext) {
    for (const handler of this.handlers.get(name) ?? []) {
      await handler(event, ctx);
    }
  }
}

test("renders published governor state through the existing custom footer", async () => {
  const pi = new FakePi();
  let footerFactory: FooterFactory | undefined;
  const ui = {
    setHeader: () => undefined,
    setFooter: (factory: FooterFactory | undefined) => {
      footerFactory = factory;
    },
    setTitle: () => undefined,
  };
  const ctx = {
    mode: "tui",
    cwd: "/tmp/context-governor-ui",
    ui,
  } as unknown as ExtensionContext;

  uiCustomization(pi as unknown as ExtensionAPI);
  await pi.emit("session_start", { type: "session_start" }, ctx);

  const base = emptyGovernorState();
  pi.events.emit(CONTEXT_GOVERNOR_CHANNEL, {
    ...base,
    capturedAtMs: 1,
    sessionId: "session",
    model: { provider: "provider", id: "model", contextWindow: 272_000 },
    measurement: {
      tokens: 157_000,
      contextWindow: 272_000,
      percent: 57.7,
      source: "pi-usage",
    },
    budget: {
      nativeLimitTokens: null,
      nativeSource: "unavailable",
      nativeProactiveEnabled: null,
      advisoryLimitTokens: 190_400,
      effectiveSafeLimitTokens: 190_000,
      effectiveSource: "governor-percent",
    },
    headroomTokens: 33_000,
    safeLimitRatio: 157_000 / 190_000,
    growth: {
      latestTokens: 31_000,
      ewmaTokens: 31_000,
      p95Tokens: 31_000,
      conservativeTokens: 31_000,
      sampleCount: 1,
    },
    runwayRuns: 1.1,
    pressure: { level: "orange", reasons: ["runway"] },
  });

  assert.ok(footerFactory);
  const footer = footerFactory(
    { requestRender() {} },
    { fg: (_color, text) => text },
    {
      getGitBranch: () => null,
      getExtensionStatuses: () => new Map(),
      onBranchChange: () => () => undefined,
    },
  );
  const lines = footer.render(100);
  assert.equal(lines[2], "157k/272k · safe 190k · +31k · ~1.1 runs · orange");

  await pi.emit("session_shutdown", { type: "session_shutdown" }, ctx);
  assert.equal(footerFactory, undefined);
});
