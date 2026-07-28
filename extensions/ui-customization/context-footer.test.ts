import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
  emptyGovernorState,
  type GovernorState,
  type PressureLevel,
} from "../shared/context-governor-state.ts";
import {
  contextFooterText,
  formatContextFooter,
} from "./src/context-footer.ts";

function stateWith(overrides: {
  readonly source?: GovernorState["measurement"]["source"];
  readonly tokens?: number | null;
  readonly contextWindow?: number;
  readonly safeLimit?: number | null;
  readonly latestGrowth?: number | null;
  readonly runway?: number | null;
  readonly pressure?: PressureLevel | null;
  readonly footerEnabled?: boolean;
}) {
  const base = emptyGovernorState();
  return {
    ...base,
    measurement: {
      ...base.measurement,
      tokens: overrides.tokens === undefined ? 157_000 : overrides.tokens,
      contextWindow: overrides.contextWindow ?? 272_000,
      percent: 57.7,
      source: overrides.source ?? "pi-usage",
    },
    budget: {
      ...base.budget,
      effectiveSafeLimitTokens:
        overrides.safeLimit === undefined ? 190_000 : overrides.safeLimit,
      effectiveSource: "governor-percent",
    },
    growth: {
      ...base.growth,
      latestTokens:
        overrides.latestGrowth === undefined ? 31_000 : overrides.latestGrowth,
      sampleCount: 1,
    },
    runwayRuns: overrides.runway === undefined ? 1.1 : overrides.runway,
    pressure: {
      level: overrides.pressure === undefined ? "orange" : overrides.pressure,
      reasons: [],
    },
    footerEnabled: overrides.footerEnabled ?? base.footerEnabled,
  } satisfies GovernorState;
}

function textAt(state: Readonly<GovernorState>, width: number) {
  return contextFooterText(formatContextFooter(state, width));
}

test("renders the full compact target from one governor state", () => {
  const segments = formatContextFooter(stateWith({}), 80);

  assert.equal(
    contextFooterText(segments),
    "157k/272k · safe 190k · +31k · ~1.1 runs · orange",
  );
  assert.deepEqual(
    segments.find((segment) => segment.role === "pressure"),
    { text: "orange", role: "pressure", tone: "orange" },
  );
});

test("labels estimated and unknown values explicitly", () => {
  assert.equal(
    textAt(stateWith({ source: "message-estimate" }), 100),
    "est 157k/272k · safe 190k · +31k · ~1.1 runs · orange",
  );

  const unknown = stateWith({
    source: "unknown",
    tokens: null,
    safeLimit: null,
    latestGrowth: null,
    runway: null,
    pressure: null,
  });
  assert.equal(
    textAt(unknown, 120),
    "unknown/272k · safe unknown · growth unknown · runway unknown · pressure unknown",
  );
});

test("renders finite zero and negative runway as exhausted", () => {
  for (const runway of [0, -0.25]) {
    const segments = formatContextFooter(stateWith({ runway }), 100);

    assert.equal(
      contextFooterText(segments),
      "157k/272k · safe 190k · +31k · runway exhausted · orange",
    );
    assert.deepEqual(
      segments.find((segment) => segment.role === "runway"),
      { text: "runway exhausted", role: "runway", tone: "muted" },
    );
  }
});

test("returns no segments when the published state disables the footer", () => {
  const state = stateWith({ footerEnabled: false });

  assert.deepEqual(formatContextFooter(state, 100), []);
  assert.equal(textAt(state, 100), "");
});

test("uses published pressure directly instead of recalculating it", () => {
  const state = stateWith({
    tokens: 260_000,
    safeLimit: 190_000,
    runway: 0.1,
    pressure: "green",
  });
  const segments = formatContextFooter(state, 100);

  assert.equal(contextFooterText(segments).endsWith(" · green"), true);
  assert.deepEqual(
    segments.find((segment) => segment.role === "pressure"),
    { text: "green", role: "pressure", tone: "green" },
  );
});

test("degrades through deterministic narrow-width variants", () => {
  const state = stateWith({});
  const cases = [
    [49, "157k/272k · safe 190k · +31k · ~1.1 runs · orange"],
    [48, "157k/272k · +31k · ~1.1 runs · orange"],
    [33, "157k/272k · +31k · ~1.1r · orange"],
    [30, "157k/272k · safe 190k · orange"],
    [26, "157k/272k · ~1.1r · orange"],
    [18, "157k/272k · orange"],
    [9, "157k/272k"],
    [8, "orange"],
    [5, "oran…"],
    [1, "…"],
    [0, ""],
  ] as const;

  for (const [width, expected] of cases) {
    assert.equal(textAt(state, width), expected, `width ${width}`);
  }
});

test("never exceeds fixed visible widths", () => {
  const states = [
    stateWith({}),
    stateWith({ source: "message-estimate" }),
    stateWith({
      source: "unknown",
      tokens: null,
      contextWindow: 0,
      safeLimit: null,
      latestGrowth: null,
      runway: null,
      pressure: null,
    }),
    stateWith({ pressure: "emergency", runway: 123.45 }),
    stateWith({ runway: 0 }),
    stateWith({ runway: -0.25 }),
    stateWith({ footerEnabled: false }),
  ];
  const widths = [0, 1, 2, 5, 8, 9, 12, 18, 26, 33, 49, 80];

  for (const state of states) {
    for (const width of widths) {
      const text = textAt(state, width);
      assert.equal(
        visibleWidth(text) <= width,
        true,
        `width ${width}: ${JSON.stringify(text)}`,
      );
    }
  }
});

test("keeps separators muted and pressure in its own color-ready segment", () => {
  const segments = formatContextFooter(stateWith({ pressure: "red" }), 80);

  assert.equal(
    segments
      .filter((segment) => segment.role === "separator")
      .every((segment) => segment.tone === "muted"),
    true,
  );
  assert.deepEqual(segments.at(-1), {
    text: "red",
    role: "pressure",
    tone: "red",
  });
});
