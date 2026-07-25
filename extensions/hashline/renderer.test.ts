import assert from "node:assert/strict";
import test from "node:test";
import { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { createHashlineRenderer, HashlineEditComponent } from "./renderer.ts";
import { SnapshotStore } from "./snapshot-store.ts";
import { createStreamingPreview } from "./streaming-preview.ts";

const theme = new Theme(
  {
    accent: "#00ffff",
    border: "#808080",
    borderAccent: "#00ffff",
    borderMuted: "#808080",
    success: "#00ff00",
    error: "#ff0000",
    warning: "#ffff00",
    muted: "#808080",
    dim: "#808080",
    text: "#ffffff",
    thinkingText: "#ffffff",
    userMessageText: "#ffffff",
    customMessageText: "#ffffff",
    customMessageLabel: "#00ffff",
    toolTitle: "#00ffff",
    toolOutput: "#ffffff",
    mdHeading: "#00ffff",
    mdLink: "#0000ff",
    mdLinkUrl: "#0000ff",
    mdCode: "#ffff00",
    mdCodeBlock: "#ffffff",
    mdCodeBlockBorder: "#808080",
    mdQuote: "#ffffff",
    mdQuoteBorder: "#808080",
    mdHr: "#808080",
    mdListBullet: "#00ffff",
    toolDiffAdded: "#00ff00",
    toolDiffRemoved: "#ff0000",
    toolDiffContext: "#808080",
    syntaxComment: "#808080",
    syntaxKeyword: "#ff00ff",
    syntaxFunction: "#0000ff",
    syntaxVariable: "#ffffff",
    syntaxString: "#00ff00",
    syntaxNumber: "#ffff00",
    syntaxType: "#00ffff",
    syntaxOperator: "#ffffff",
    syntaxPunctuation: "#ffffff",
    thinkingOff: "#808080",
    thinkingMinimal: "#808080",
    thinkingLow: "#0000ff",
    thinkingMedium: "#00ffff",
    thinkingHigh: "#ff00ff",
    thinkingXhigh: "#ff0000",
    thinkingMax: "#ffff00",
    bashMode: "#00ff00",
  },
  {
    selectedBg: "#000000",
    userMessageBg: "#000000",
    customMessageBg: "#000000",
    toolPendingBg: "#000000",
    toolSuccessBg: "#000000",
    toolErrorBg: "#000000",
  },
  "256color",
);

const plain = (lines: string[]) =>
  lines.join("\n").replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");

const settle = () => new Promise((resolve) => setTimeout(resolve, 60));

test("partial-argument cadence previews only complete structured operations and hides protocol", async () => {
  const store = new SnapshotStore();
  const snapshot = store.recordRead({
    canonicalPath: "/project/a.ts",
    displayPath: "a.ts",
    text: "one\ntwo\nthree\n",
    seenLines: [1, 2, 3],
  });
  const renderer = createHashlineRenderer(store);
  const state = {};
  let invalidations = 0;
  const context = {
    args: {},
    state,
    lastComponent: undefined,
    invalidate: () => invalidations++,
    cwd: "/project",
    argsComplete: false,
    executionStarted: false,
    isPartial: true,
    expanded: false,
    isError: false,
  };

  const partial = {
    path: "a.ts",
    tag: snapshot.tag,
    operations: [
      { op: "replace", start: 2, end: 2, lines: ["TWO"] },
      { op: "delete", start: 3 },
    ],
  };
  const component = Reflect.apply(renderer.renderCall, renderer, [
    partial,
    theme,
    context,
  ]);
  context.lastComponent = component;
  await settle();
  const rendered = plain(component.render(80));
  assert.match(rendered, /-2 two/);
  assert.match(rendered, /\+2 TWO/);
  assert.doesNotMatch(rendered, new RegExp(snapshot.tag));
  assert.doesNotMatch(rendered, /operations|"op"|"start"/);
  assert.match(rendered, /previewing/);
  assert.equal(invalidations, 1);

  Reflect.apply(renderer.renderCall, renderer, [
    {
      ...partial,
      operations: [partial.operations[0], { op: "delete", start: 3, end: 3 }],
    },
    theme,
    context,
  ]);
  await settle();
  assert.equal(
    invalidations,
    2,
    "successive partial args trigger fresh preview invalidation",
  );
  assert.match(plain(component.render(80)), /-3 three/);
});

test("new invalid or missing candidates clear a prior preview immediately", async () => {
  const store = new SnapshotStore();
  const snapshot = store.recordRead({
    canonicalPath: "/project/a.ts",
    resolvedPath: "/project/a.ts",
    displayPath: "a.ts",
    text: "one\ntwo\n",
    byteIdentity: "identity",
    seenLines: [1, 2],
  });
  const renderer = createHashlineRenderer(store);
  const state = {};
  const context = {
    args: {},
    state,
    lastComponent: undefined,
    invalidate: () => {},
    cwd: "/project",
    argsComplete: false,
    executionStarted: false,
    isPartial: true,
    expanded: false,
    isError: false,
  };
  const component = Reflect.apply(renderer.renderCall, renderer, [
    {
      path: "a.ts",
      tag: snapshot.tag,
      operations: [{ op: "replace", start: 2, end: 2, lines: ["TWO"] }],
    },
    theme,
    context,
  ]);
  context.lastComponent = component;
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.match(plain(component.render(80)), /TWO/);

  Reflect.apply(renderer.renderCall, renderer, [
    {
      path: "a.ts",
      tag: snapshot.tag,
      operations: [{ op: "replace", start: 2 }],
    },
    theme,
    context,
  ]);
  assert.match(
    plain(component.render(80)),
    /TWO/,
    "an incomplete operation for the same path and tag retains the preview",
  );

  Reflect.apply(renderer.renderCall, renderer, [
    { path: "other.ts", tag: snapshot.tag, operations: [] },
    theme,
    context,
  ]);
  const cleared = plain(component.render(80));
  assert.match(cleared, /other\.ts/);
  assert.doesNotMatch(cleared, /TWO|two/);
});

test("settled preview remains visible until its same-target replacement lands", () => {
  const store = new SnapshotStore();
  const snapshot = store.recordRead({
    canonicalPath: "/project/a.ts",
    resolvedPath: "/project/a.ts",
    displayPath: "a.ts",
    text: "one\ntwo\n",
    byteIdentity: "identity",
    seenLines: [1, 2],
  });
  let pending: (() => void) | undefined;
  const renderer = createHashlineRenderer(store, {
    schedulePreview(callback) {
      pending = callback;
      return () => {
        if (pending === callback) pending = undefined;
      };
    },
  });
  const state = {};
  const context = {
    args: {},
    state,
    lastComponent: undefined,
    invalidate: () => {},
    cwd: "/project",
    argsComplete: false,
    executionStarted: false,
    isPartial: true,
    expanded: false,
    isError: false,
  };
  const args = (line: string) => ({
    path: "a.ts",
    tag: snapshot.tag,
    operations: [{ op: "replace", start: 2, end: 2, lines: [line] }],
  });

  const component = Reflect.apply(renderer.renderCall, renderer, [
    args("PREVIEW_A"),
    theme,
    context,
  ]);
  context.lastComponent = component;
  assert.ok(pending);
  pending();
  assert.match(plain(component.render(80)), /PREVIEW_A/);
  const settledALines = plain(component.render(80)).split("\n");
  assert.doesNotMatch(settledALines[0] ?? "", /previewing/);
  assert.match(settledALines.at(-2) ?? "", /previewing/);
  assert.ok(settledALines.length <= 10);

  Reflect.apply(renderer.renderCall, renderer, [
    args("PREVIEW_B"),
    theme,
    context,
  ]);
  const whilePending = plain(component.render(80));
  assert.match(whilePending, /PREVIEW_A/);
  assert.doesNotMatch(whilePending, /PREVIEW_B/);

  assert.ok(pending);
  pending();
  const settledB = plain(component.render(80));
  assert.match(settledB, /PREVIEW_B/);
  assert.doesNotMatch(settledB, /PREVIEW_A/);
});

test("preview scheduling coalesces latest-only work and never applies superseded jobs", () => {
  const store = new SnapshotStore();
  const snapshot = store.recordRead({
    canonicalPath: "/project/a.ts",
    resolvedPath: "/project/a.ts",
    displayPath: "a.ts",
    text: "one\ntwo\n",
    byteIdentity: "identity",
    seenLines: [1, 2],
  });
  let pending: (() => void) | undefined;
  let computes = 0;
  const renderer = createHashlineRenderer(store, {
    schedulePreview(callback) {
      pending = callback;
      return () => {
        if (pending === callback) pending = undefined;
      };
    },
    computePreview(original, operations, seenLines) {
      computes++;
      return createStreamingPreview(original, operations, seenLines);
    },
  });
  const state = {};
  const context = {
    args: {},
    state,
    lastComponent: undefined,
    invalidate: () => {},
    cwd: "/project",
    argsComplete: false,
    executionStarted: false,
    isPartial: true,
    expanded: false,
    isError: false,
  };
  const args = (line: string) => ({
    path: "a.ts",
    tag: snapshot.tag,
    operations: [{ op: "replace", start: 2, end: 2, lines: [line] }],
  });
  const component = Reflect.apply(renderer.renderCall, renderer, [
    args("TWO"),
    theme,
    context,
  ]);
  context.lastComponent = component;
  Reflect.apply(renderer.renderCall, renderer, [
    args("SECOND"),
    theme,
    context,
  ]);
  assert.equal(computes, 0);
  assert.ok(pending);
  pending();
  assert.equal(computes, 1);
  assert.match(plain(component.render(80)), /SECOND/);
  assert.doesNotMatch(plain(component.render(80)), /TWO/);

  Reflect.apply(renderer.renderCall, renderer, [args("NEVER"), theme, context]);
  Reflect.apply(renderer.renderCall, renderer, [
    { path: "missing.ts", tag: snapshot.tag, operations: [] },
    theme,
    context,
  ]);
  pending?.();
  assert.equal(
    computes,
    1,
    "superseded invalid work is cancelled before compute",
  );
  assert.doesNotMatch(plain(component.render(80)), /NEVER|SECOND/);
});

test("preview accepts valid long edits above the former conservative caps", () => {
  const store = new SnapshotStore();
  const sourceLines = ["x".repeat(600 * 1024), ...Array(29).fill("line")];
  const snapshot = store.recordRead({
    canonicalPath: "/project/large.ts",
    resolvedPath: "/project/large.ts",
    displayPath: "large.ts",
    text: `${sourceLines.join("\n")}\n`,
    byteIdentity: "identity",
    seenLines: sourceLines.map((_, index) => index + 1),
  });
  let pending: (() => void) | undefined;
  let scheduled = 0;
  const renderer = createHashlineRenderer(store, {
    schedulePreview(callback) {
      scheduled++;
      pending = callback;
      return () => {};
    },
  });
  const context = {
    args: {},
    state: {},
    lastComponent: undefined,
    invalidate: () => {},
    cwd: "/project",
    argsComplete: false,
    executionStarted: false,
    isPartial: true,
    expanded: false,
    isError: false,
  };
  const component = Reflect.apply(renderer.renderCall, renderer, [
    {
      path: "large.ts",
      tag: snapshot.tag,
      operations: Array.from({ length: 26 }, (_, index) => ({
        op: "insert-after",
        line: index + 1,
        lines: [`inserted-${index + 1}`],
      })),
    },
    theme,
    context,
  ]);

  assert.equal(scheduled, 1);
  assert.ok(pending);
  pending();
  assert.match(plain(component.render(80)), /inserted-26/);
});

test("preview still refuses candidates beyond tool and memory bounds", () => {
  const mebibyte = 1024 * 1024;
  let scheduled = 0;
  const schedulePreview = () => {
    scheduled++;
    return () => {};
  };
  const context = () => ({
    args: {},
    state: {},
    lastComponent: undefined,
    invalidate: () => {},
    cwd: "/project",
    argsComplete: false,
    executionStarted: false,
    isPartial: true,
    expanded: false,
    isError: false,
  });

  const smallStore = new SnapshotStore();
  const small = smallStore.recordRead({
    canonicalPath: "/project/small.ts",
    resolvedPath: "/project/small.ts",
    displayPath: "small.ts",
    text: "one\n",
    byteIdentity: "small",
    seenLines: [1],
  });
  const smallRenderer = createHashlineRenderer(smallStore, { schedulePreview });
  Reflect.apply(smallRenderer.renderCall, smallRenderer, [
    {
      path: "small.ts",
      tag: small.tag,
      operations: Array.from({ length: 101 }, (_, index) => ({
        op: "insert-after",
        line: 1,
        lines: [`line-${index}`],
      })),
    },
    theme,
    context(),
  ]);
  Reflect.apply(smallRenderer.renderCall, smallRenderer, [
    {
      path: "small.ts",
      tag: small.tag,
      operations: [
        {
          op: "replace",
          start: 1,
          end: 1,
          lines: ["y".repeat(4 * mebibyte)],
        },
      ],
    },
    theme,
    context(),
  ]);

  const largeStore = new SnapshotStore({
    maxSnapshotBytes: 5 * mebibyte,
    maxBytes: 6 * mebibyte,
  });
  const large = largeStore.recordRead({
    canonicalPath: "/project/too-large.ts",
    resolvedPath: "/project/too-large.ts",
    displayPath: "too-large.ts",
    text: "x".repeat(4 * mebibyte + 1),
    byteIdentity: "large",
    seenLines: [1],
  });
  const largeRenderer = createHashlineRenderer(largeStore, { schedulePreview });
  Reflect.apply(largeRenderer.renderCall, largeRenderer, [
    {
      path: "too-large.ts",
      tag: large.tag,
      operations: [{ op: "replace", start: 1, end: 1, lines: ["small"] }],
    },
    theme,
    context(),
  ]);

  assert.equal(scheduled, 0);
});

test("body borders align at the card edge for short and truncated lines", () => {
  const width = 36;
  const component = new HashlineEditComponent(theme);
  component.updateArgs({ path: `${"very-long/".repeat(12)}border.ts` }, false);
  component.settleSuccess(
    {
      diff: `-1 short\n+1 ${"long content ".repeat(8)}`,
      patch: "patch",
      firstChangedLine: 1,
    },
    false,
    theme,
  );

  const lines = component
    .render(width)
    .map((line) => line.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, ""));
  const body = lines.slice(1, -1);
  assert.equal(lines[0]?.at(-1), "╮");
  assert.equal(lines.at(-1)?.at(-1), "╯");
  assert.equal(body.length, 2);
  for (const line of body) {
    assert.equal(visibleWidth(line), width);
    assert.equal(line.at(-1), "│");
  }
  assert.match(body[1] ?? "", /… │$/);
  assert.ok(lines.every((line) => visibleWidth(line) === width));
});

test("untrusted terminal controls and tabs cannot escape the card", () => {
  const width = 52;
  const component = new HashlineEditComponent(theme);
  component.updateArgs(
    { path: "safe\t\x1b]0;owned-title\x07\x1b]2;st-owned\x1b\\name\x07.ts" },
    false,
  );
  component.settleSuccess(
    {
      diff: "+1 alpha\tbeta\x07\x1b[31mred\x1b[0m\x1b]8;;https://evil.test\x07link\x1b]8;;\x07",
      patch: "patch",
      firstChangedLine: 1,
    },
    false,
    theme,
  );

  const rendered = component.render(width);
  const text = plain(rendered);
  assert.doesNotMatch(rendered.join(""), /\x1b\]|\x07|\t|\x1b\[31m/);
  assert.doesNotMatch(text, /owned-title|st-owned|https:\/\/evil\.test/);
  assert.match(text, /safe {4}name\.ts/);
  assert.match(text, /alpha {4}betaredlink/);
  for (const line of text.split("\n")) {
    assert.equal(visibleWidth(line), width);
    assert.match(line, /[╮│╯]$/);
  }
});

test("pending status and hidden marker share the collapsed row budget", () => {
  const component = new HashlineEditComponent(theme);
  component.updateArgs({ path: "pending.ts" }, false);
  const generation = component.beginPreview("preview", "target");
  component.setPreview(
    "preview",
    generation,
    Array.from(
      { length: 10 },
      (_, index) => `+${index + 1} line-${index + 1}`,
    ).join("\n"),
  );

  const lines = plain(component.render(60)).split("\n");
  assert.equal(lines.length, 10);
  assert.match(lines[1] ?? "", /4 diff lines above/);
  assert.doesNotMatch(lines.join("\n"), /line-1\b/);
  assert.match(lines.join("\n"), /line-10/);
  assert.match(lines.at(-2) ?? "", /previewing/);
});

test("collapsed and expanded rendering use bounded bottom-pinned logical diff tails", () => {
  const component = new HashlineEditComponent(theme);
  component.updateArgs({ path: "long.ts" }, false);
  const diff = Array.from(
    { length: 50 },
    (_, index) => `+${index + 1} line-${index + 1}`,
  ).join("\n");
  component.settleSuccess(
    { diff, patch: "patch", firstChangedLine: 1 },
    false,
    theme,
  );
  const collapsed = plain(component.render(60));
  assert.match(collapsed, /43 diff lines above/);
  assert.doesNotMatch(collapsed, /line-1\b/);
  assert.match(collapsed, /line-50/);
  assert.ok(component.render(60).every((line) => visibleWidth(line) <= 60));

  component.settleSuccess(
    { diff, patch: "patch", firstChangedLine: 1 },
    true,
    theme,
  );
  const expanded = plain(component.render(60));
  assert.match(expanded, /11 diff lines above/);
  assert.match(expanded, /line-50/);
  assert.doesNotMatch(expanded, /[0-9A-F]{16}|"operations"/);
  assert.ok(component.render(60).length <= 42);
});

test("a late preview callback cannot overwrite an authoritative result", () => {
  const store = new SnapshotStore();
  const snapshot = store.recordRead({
    canonicalPath: "/project/a.ts",
    resolvedPath: "/project/a.ts",
    displayPath: "a.ts",
    text: "old\n",
    byteIdentity: "identity",
    seenLines: [1],
  });
  let callback: (() => void) | undefined;
  const renderer = createHashlineRenderer(store, {
    schedulePreview(next) {
      callback = next;
      return () => {};
    },
  });
  const state = {};
  const context = {
    args: {},
    state,
    lastComponent: undefined,
    invalidate: () => {},
    cwd: "/project",
    argsComplete: false,
    executionStarted: false,
    isPartial: true,
    expanded: false,
    isError: false,
  };
  const component = Reflect.apply(renderer.renderCall, renderer, [
    {
      path: "a.ts",
      tag: snapshot.tag,
      operations: [{ op: "replace", start: 1, end: 1, lines: ["preview"] }],
    },
    theme,
    context,
  ]);
  context.lastComponent = component;
  assert.ok(callback);

  Reflect.apply(renderer.renderResult, renderer, [
    {
      content: [{ type: "text", text: "done" }],
      details: {
        diff: "-1 old\n+1 authoritative",
        patch: "patch",
        firstChangedLine: 1,
      },
    },
    { expanded: false, isPartial: false },
    theme,
    context,
  ]);
  const finalCard = plain(component.render(80));
  callback();

  assert.equal(plain(component.render(80)), finalCard);
  assert.match(finalCard, /✓ edit a\.ts:1/);
  assert.match(finalCard, /authoritative/);
  assert.doesNotMatch(finalCard, /previewing/);
});

test("authoritative result mutates the call card, emits no duplicate result, and shows final errors", () => {
  const store = new SnapshotStore();
  const renderer = createHashlineRenderer(store);
  const component = new HashlineEditComponent(theme);
  component.updateArgs({ path: "a.ts" }, false);
  const state = { callComponent: component };
  const context = {
    args: { path: "a.ts" },
    state,
    lastComponent: undefined,
    invalidate: () => {},
    cwd: "/project",
    argsComplete: true,
    executionStarted: true,
    isPartial: false,
    expanded: false,
    isError: false,
  };
  const emptyResult = Reflect.apply(renderer.renderResult, renderer, [
    {
      content: [
        {
          type: "text",
          text: "done\n[a.ts#FEDCBA9876543210]\n1:new",
        },
      ],
      details: { diff: "-1 old\n+1 new", patch: "patch", firstChangedLine: 1 },
    },
    { expanded: false, isPartial: false },
    theme,
    context,
  ]);
  assert.deepEqual(emptyResult.render(80), []);
  const success = plain(component.render(80));
  assert.match(success, /✓ edit a\.ts:1 \+1 -1/);
  assert.match(success, /\+1 new/);
  assert.doesNotMatch(success, /FEDCBA9876543210|"operations"/);

  context.isError = true;
  Reflect.apply(renderer.renderResult, renderer, [
    {
      content: [
        {
          type: "text",
          text: 'Stale snapshot a.ts#0123456789ABCDEF; re-read and retry. {"operations":[{"op":"delete","start":1,"end":1}]}',
        },
      ],
      details: undefined,
    },
    { expanded: false, isPartial: false },
    theme,
    context,
  ]);
  const error = plain(component.render(80));
  assert.match(error, /✗ edit a\.ts/);
  assert.match(error, /Stale snapshot/);
  assert.match(error, /re-read and retry/);
  assert.match(error, /structured operation details/);
  assert.doesNotMatch(error, /0123456789ABCDEF|"operations"|"op"/);
});
