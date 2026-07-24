import {
  ThinkingSelectorComponent,
  type ExtensionCommandContext,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import {
  getSupportedThinkingLevels,
  type Api,
  type Model,
  type ModelThinkingLevel,
} from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import type { ReasoningLevel, SummaryConfig } from "./config.ts";
import type { RunRecap } from "./summarizer.ts";

export interface RecapEntryData extends RunRecap {
  readonly provider: string;
  readonly model: string;
  readonly reasoning: ReasoningLevel;
  readonly fallback?: boolean;
}

function inlineText(value: string | undefined) {
  return value?.replace(/\s+/g, " ").trim() ?? "";
}

function sentence(text: string) {
  return /[.!?…](?:["'’”)\]}*_~`]+)?$/.test(text) ? text : `${text}.`;
}

function formatRecap(data: RecapEntryData | undefined) {
  if (!data) return "※ recap: unavailable.";

  const recap = inlineText(data.recap);
  const next = inlineText(data.next).replace(/^(?:next\s*[:,]\s*)+/i, "");
  if (!recap && !next) return "※ recap: unavailable.";

  const body = [
    recap ? sentence(recap) : undefined,
    next ? `Next, ${sentence(next)}` : undefined,
  ]
    .filter((part): part is string => part !== undefined)
    .join(" ");
  return `※ recap: ${body}`;
}

class RecapText {
  private readonly data: RecapEntryData | undefined;
  private readonly theme: Theme;
  private readonly expanded: boolean;

  constructor(
    data: RecapEntryData | undefined,
    theme: Theme,
    expanded: boolean,
  ) {
    this.data = data;
    this.theme = theme;
    this.expanded = expanded;
  }

  render(width: number) {
    const recap = this.theme.fg(
      "dim",
      this.theme.italic(formatRecap(this.data)),
    );
    if (!this.expanded || !this.data) {
      return new Text(recap, 0, 0).render(width);
    }

    const metadata = `${this.data.provider}/${this.data.model} · ${this.data.reasoning}${this.data.fallback ? " · local fallback" : ""}`;
    return new Text(`${recap}\n${this.theme.fg("dim", metadata)}`, 0, 0).render(
      width,
    );
  }

  invalidate() {}
}

export function renderRecap(
  data: RecapEntryData | undefined,
  expanded: boolean,
  theme: Theme,
) {
  return new RecapText(data, theme, expanded);
}

export async function openModelPicker(
  ctx: ExtensionCommandContext,
  _config: SummaryConfig,
) {
  const models = [...ctx.modelRegistry.getAvailable()].sort((a, b) =>
    `${a.provider}/${a.id}`.localeCompare(`${b.provider}/${b.id}`),
  );
  if (models.length === 0) {
    ctx.ui.notify(
      "No configured models are available for run recaps.",
      "warning",
    );
    return undefined;
  }
  const labels = models.map((model) => `${model.provider}/${model.id}`);
  const selected = await ctx.ui.select("Summary model", labels);
  return selected === undefined ? undefined : models[labels.indexOf(selected)];
}

export function openReasoningPicker(
  ctx: ExtensionCommandContext,
  model: Model<Api>,
  current: ReasoningLevel,
) {
  const supported = getSupportedThinkingLevels(model);
  const selectedCurrent = supported.includes(current)
    ? current
    : (supported[0] ?? "off");

  return ctx.ui.custom<ModelThinkingLevel | undefined>(
    (tui, _theme, _keybindings, done) => {
      const selector = new ThinkingSelectorComponent(
        selectedCurrent,
        supported,
        (level) => done(level),
        () => done(undefined),
      );
      const list = selector.getSelectList();
      return {
        render: (width) => selector.render(width),
        invalidate: () => selector.invalidate(),
        handleInput: (data) => {
          list.handleInput(data);
          tui.requestRender();
        },
      };
    },
  );
}
