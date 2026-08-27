import assert from "node:assert/strict";
import test from "node:test";
import {
  formatCodexWeeklyUsage,
  parseCodexWeeklyUsageHeaders,
  parseCodexWeeklyUsagePayload,
} from "./src/codex-usage.ts";

const NOW = 1_800_000_000_000;

test("finds a weekly Codex limit when it is the primary window", () => {
  const usage = parseCodexWeeklyUsagePayload(
    {
      rate_limit: {
        primary_window: {
          used_percent: 8,
          limit_window_seconds: 604_800,
          reset_after_seconds: 566_128,
        },
        secondary_window: null,
      },
    },
    NOW,
  );

  assert.deepEqual(usage, {
    usedPercent: 8,
    remainingPercent: 92,
    resetsAtMs: NOW + 566_128_000,
    fetchedAtMs: NOW,
  });
});

test("finds a weekly Codex limit when it is the secondary window", () => {
  const usage = parseCodexWeeklyUsagePayload(
    {
      rate_limit: {
        primary_window: {
          used_percent: 30,
          limit_window_seconds: 18_000,
        },
        secondary_window: {
          used_percent: 42.5,
          limit_window_seconds: 604_800,
          reset_at: NOW / 1_000 + 172_800,
        },
      },
    },
    NOW,
  );

  assert.equal(usage?.remainingPercent, 57.5);
  assert.equal(usage?.resetsAtMs, NOW + 172_800_000);
});

test("parses weekly usage snapshots from Codex response headers", () => {
  const usage = parseCodexWeeklyUsageHeaders(
    {
      "X-Codex-Primary-Used-Percent": "12",
      "X-Codex-Primary-Window-Minutes": "10080",
      "X-Codex-Primary-Reset-At": String(NOW / 1_000 + 86_400),
    },
    NOW,
  );

  assert.equal(usage?.remainingPercent, 88);
  assert.equal(usage?.resetsAtMs, NOW + 86_400_000);
});

test("does not mislabel a five-hour-only limit as weekly", () => {
  const usage = parseCodexWeeklyUsagePayload(
    {
      rate_limit: {
        primary_window: {
          used_percent: 20,
          limit_window_seconds: 18_000,
        },
      },
    },
    NOW,
  );

  assert.equal(usage, undefined);
});

test("formats remaining percentage and reset countdown", () => {
  assert.equal(
    formatCodexWeeklyUsage(
      {
        usedPercent: 8,
        remainingPercent: 92,
        resetsAtMs: NOW + (2 * 24 + 3) * 60 * 60 * 1_000,
        fetchedAtMs: NOW,
      },
      NOW,
    ),
    "Codex week 92% left · resets 2d 3h",
  );
});
