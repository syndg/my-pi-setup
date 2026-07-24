import assert from "node:assert/strict";
import test from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { renderRecap, type RecapEntryData } from "./src/ui.ts";

// Tests use ANSI wrappers so wrapping exercises the same styled-text path as Pi.
const theme = {
  fg: (_color: string, text: string) => `\u001b[38;5;245m${text}\u001b[39m`,
  italic: (text: string) => `\u001b[3m${text}\u001b[23m`,
  bg: () => {
    throw new Error("compact recaps must not use a background");
  },
} as unknown as Theme;

const baseRecap: RecapEntryData = {
  recap: "Shipped the café search.",
  next: "Run 日本語 smoke tests.",
  provider: "anthropic",
  model: "claude",
  reasoning: "medium",
};

function stripAnsi(text: string) {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
}

function visibleLines(
  data: RecapEntryData | undefined,
  expanded: boolean,
  width: number,
) {
  return renderRecap(data, expanded, theme)
    .render(width)
    .map((line) => stripAnsi(line).trimEnd());
}

test("renders the collapsed recap as one quiet inline paragraph", () => {
  const lines = visibleLines(baseRecap, false, 100);

  assert.deepEqual(lines, [
    "※ recap: Shipped the café search. Next, Run 日本語 smoke tests.",
  ]);
  assert.equal(
    lines.some((line) => line.includes("Run recap")),
    false,
  );
  assert.equal(
    lines.some((line) => line.includes("Next:")),
    false,
  );
});

test("wraps styled Unicode text naturally at the terminal width", () => {
  const component = renderRecap(baseRecap, false, theme);
  const rendered = component.render(24);

  assert.deepEqual(
    rendered.map((line) => stripAnsi(line).trimEnd()),
    ["※ recap: Shipped the", "café search. Next, Run", "日本語 smoke tests."],
  );
  assert.equal(
    rendered.every((line) => visibleWidth(line) <= 24),
    true,
  );
});

test("expanded rendering adds only a compact metadata line", () => {
  assert.deepEqual(visibleLines(baseRecap, true, 24), [
    "※ recap: Shipped the",
    "café search. Next, Run",
    "日本語 smoke tests.",
    "anthropic/claude ·",
    "medium",
  ]);
});

test("expanded fallback metadata keeps its local fallback label", () => {
  assert.deepEqual(
    visibleLines(
      {
        ...baseRecap,
        recap: "Used the local summary.",
        next: "Review it.",
        provider: "ollama",
        model: "tiny",
        reasoning: "off",
        fallback: true,
      },
      true,
      100,
    ),
    [
      "※ recap: Used the local summary. Next, Review it.",
      "ollama/tiny · off · local fallback",
    ],
  );
});

test("normalizes whitespace, leading Next labels, and sentence punctuation", () => {
  assert.deepEqual(
    visibleLines(
      {
        ...baseRecap,
        recap: "  Fixed\n  the odd case?!  ",
        next: " Next: check logs... ",
      },
      false,
      100,
    ),
    ["※ recap: Fixed the odd case?! Next, check logs..."],
  );

  assert.deepEqual(
    visibleLines({ ...baseRecap, recap: "", next: "" }, false, 100),
    ["※ recap: unavailable."],
  );
});

test("renders model Markdown as inert plain text instead of parsing it", () => {
  assert.deepEqual(
    visibleLines(
      {
        ...baseRecap,
        recap: "**Fixed** `search`",
        next: "Review [the diff](https://example.test)",
      },
      false,
      120,
    ),
    [
      "※ recap: **Fixed** `search`. Next, Review [the diff](https://example.test).",
    ],
  );
});

test("long recaps wrap without a fixed height or truncation", () => {
  const recap = Array.from({ length: 40 }, (_, index) => `item${index}`).join(
    " ",
  );
  const lines = renderRecap(
    { ...baseRecap, recap, next: "Inspect everything" },
    false,
    theme,
  ).render(16);

  assert.equal(lines.length > 15, true);
  assert.equal(
    lines.every((line) => visibleWidth(line) <= 16),
    true,
  );
  assert.equal(stripAnsi(lines.join("\n")).includes("item39"), true);
  assert.equal(
    stripAnsi(lines.join("\n"))
      .replace(/\s+/g, " ")
      .includes("Inspect everything."),
    true,
  );
});

test("missing entry data remains compact and borderless", () => {
  assert.deepEqual(visibleLines(undefined, false, 40), [
    "※ recap: unavailable.",
  ]);
});
