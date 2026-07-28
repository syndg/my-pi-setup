import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  DEFAULT_GOVERNOR_CONFIG,
  loadGovernorConfig,
  parseGovernorConfig,
} from "./src/config.ts";

test("documents the complete defensive defaults", () => {
  assert.deepEqual(DEFAULT_GOVERNOR_CONFIG, {
    advisorySafePercent: 70,
    historyLength: 20,
    ewmaAlpha: 0.35,
    conservativeQuantile: 0.95,
    minimumP95Samples: 5,
    minimumRunwaySamples: 3,
    yellowContextRatio: 0.5,
    yellowAbsoluteTokens: 150_000,
    largeRunTokens: 20_000,
    largeRunSafeFraction: 0.1,
    orangeRunwayBelow: 2,
    orangeSafeLimitRatio: 0.85,
    redRunwayBelow: 1,
    redSafeLimitRatio: 0.95,
    emergencyMarginTokens: 8_192,
    recoveryRuns: 2,
    notice: { enabled: true, maxCharacters: 320 },
    footer: { enabled: true, mode: "compact" },
    telemetry: { enabled: true, maxRecords: 200, maxBytes: 524_288 },
  });
  assert.deepEqual(parseGovernorConfig(undefined), DEFAULT_GOVERNOR_CONFIG);
  assert.ok(Object.isFrozen(DEFAULT_GOVERNOR_CONFIG));
  assert.ok(Object.isFrozen(DEFAULT_GOVERNOR_CONFIG.telemetry));
});

test("accepts valid per-field overrides in every section", () => {
  assert.deepEqual(
    parseGovernorConfig({
      advisorySafePercent: 65,
      historyLength: 7,
      ewmaAlpha: 1,
      conservativeQuantile: 0.5,
      minimumP95Samples: 4,
      minimumRunwaySamples: 2,
      yellowContextRatio: 0,
      yellowAbsoluteTokens: 0,
      largeRunTokens: 1,
      largeRunSafeFraction: 1,
      orangeRunwayBelow: 3.5,
      orangeSafeLimitRatio: 0.8,
      redRunwayBelow: 1.5,
      redSafeLimitRatio: 1,
      emergencyMarginTokens: 0,
      recoveryRuns: 3,
      notice: { enabled: false, maxCharacters: 80 },
      footer: { enabled: false, mode: "compact" },
      telemetry: { enabled: false, maxRecords: 10, maxBytes: 1024 },
    }),
    {
      advisorySafePercent: 65,
      historyLength: 7,
      ewmaAlpha: 1,
      conservativeQuantile: 0.5,
      minimumP95Samples: 4,
      minimumRunwaySamples: 2,
      yellowContextRatio: 0,
      yellowAbsoluteTokens: 0,
      largeRunTokens: 1,
      largeRunSafeFraction: 1,
      orangeRunwayBelow: 3.5,
      orangeSafeLimitRatio: 0.8,
      redRunwayBelow: 1.5,
      redSafeLimitRatio: 1,
      emergencyMarginTokens: 0,
      recoveryRuns: 3,
      notice: { enabled: false, maxCharacters: 80 },
      footer: { enabled: false, mode: "compact" },
      telemetry: { enabled: false, maxRecords: 10, maxBytes: 1024 },
    },
  );
});

test("falls back per field without discarding valid neighbors", () => {
  const parsed = parseGovernorConfig({
    advisorySafePercent: 0,
    historyLength: 2.5,
    ewmaAlpha: Number.NaN,
    conservativeQuantile: 0,
    minimumP95Samples: 0,
    minimumRunwaySamples: 1.5,
    yellowContextRatio: 2,
    yellowAbsoluteTokens: -1,
    largeRunTokens: Number.POSITIVE_INFINITY,
    largeRunSafeFraction: -0.1,
    orangeRunwayBelow: -1,
    orangeSafeLimitRatio: "0.8",
    redRunwayBelow: -1,
    redSafeLimitRatio: 0.9,
    emergencyMarginTokens: -1,
    recoveryRuns: 0,
    notice: { enabled: "yes", maxCharacters: -1 },
    footer: { enabled: false, mode: "wide" },
    telemetry: { enabled: false, maxRecords: 1.1, maxBytes: 2048 },
  });

  assert.equal(parsed.advisorySafePercent, 70);
  assert.equal(parsed.historyLength, 20);
  assert.equal(parsed.ewmaAlpha, 0.35);
  assert.equal(parsed.conservativeQuantile, 0.95);
  assert.equal(parsed.minimumP95Samples, 5);
  assert.equal(parsed.minimumRunwaySamples, 3);
  assert.equal(parsed.yellowContextRatio, 0.5);
  assert.equal(parsed.yellowAbsoluteTokens, 150_000);
  assert.equal(parsed.largeRunTokens, 20_000);
  assert.equal(parsed.largeRunSafeFraction, 0.1);
  assert.equal(parsed.orangeRunwayBelow, 2);
  assert.equal(parsed.orangeSafeLimitRatio, 0.85);
  assert.equal(parsed.redRunwayBelow, 1);
  assert.equal(parsed.redSafeLimitRatio, 0.9);
  assert.equal(parsed.emergencyMarginTokens, 8_192);
  assert.equal(parsed.recoveryRuns, 2);
  assert.deepEqual(parsed.notice, { enabled: true, maxCharacters: 320 });
  assert.deepEqual(parsed.footer, { enabled: false, mode: "compact" });
  assert.deepEqual(parsed.telemetry, {
    enabled: false,
    maxRecords: 200,
    maxBytes: 2048,
  });
});

test("malformed nested sections do not throw or disable defaults", () => {
  const hostileValues: readonly unknown[] = [
    null,
    [],
    "bad",
    42,
    { notice: null, footer: [], telemetry: "bad" },
  ];
  for (const value of hostileValues) {
    assert.deepEqual(parseGovernorConfig(value), DEFAULT_GOVERNOR_CONFIG);
  }
});

test("path-based loader reads valid JSON and fails open for missing or malformed files", () => {
  const directory = mkdtempSync(join(tmpdir(), "context-governor-config-"));
  try {
    const validPath = join(directory, "valid.json");
    const malformedPath = join(directory, "malformed.json");
    writeFileSync(
      validPath,
      JSON.stringify({ historyLength: 5, notice: { enabled: false } }),
    );
    writeFileSync(malformedPath, "{not-json");

    assert.equal(loadGovernorConfig(validPath).historyLength, 5);
    assert.equal(loadGovernorConfig(validPath).notice.enabled, false);
    assert.equal(loadGovernorConfig(validPath).notice.maxCharacters, 320);
    assert.deepEqual(
      loadGovernorConfig(malformedPath),
      DEFAULT_GOVERNOR_CONFIG,
    );
    assert.deepEqual(
      loadGovernorConfig(join(directory, "missing.json")),
      DEFAULT_GOVERNOR_CONFIG,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
