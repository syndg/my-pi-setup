import { createHash } from "node:crypto";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type {
  CandidateDecision,
  DecayAccounting,
  DecayClass,
  DecayConfig,
  DecayContext,
  DecayedContext,
  DecayEpoch,
  DecayMessageInput,
  DecayPlan,
  ProtectionReason,
  RecallReference,
  Replacement,
  SequenceValidation,
} from "./types.ts";
import { DEFAULT_DECAY_CONFIG } from "./types.ts";

interface ToolCallInfo {
  readonly id: string;
  readonly name: string;
  readonly arguments: Readonly<Record<string, unknown>>;
  readonly messageIndex: number;
}

interface IndexedMessage {
  readonly input: DecayMessageInput;
  readonly identity: string;
  readonly index: number;
  readonly tokens: number;
  readonly text: string;
  readonly tool: ToolCallInfo | null;
  readonly recall: RecallReference | null;
}

const EMPTY_OUTPUT =
  /^(?:\s*|no (?:matches|results|files|output)(?: found)?[.!]?|\[?no output\]?|0 (?:matches|results|files)[.!]?)$/i;
const ASYNC_NAME = /(?:background|subagent|workflow|child|bg_)/i;
const CHECKPOINT_NAME = /(?:checkpoint|handoff)/i;
const SEARCH_TOOLS = new Set(["rg", "fd", "grep", "find", "file-search"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object")
    return JSON.stringify(value) ?? "undefined";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
    .join(",")}}`;
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function compactDigest(value: string): string {
  return digest(value).slice(0, 20);
}

export function estimateDecayTokens(value: unknown): number {
  const bytes = Buffer.byteLength(
    typeof value === "string" ? value : canonical(value),
    "utf8",
  );
  return Math.max(1, Math.ceil(bytes / 4) + 4);
}

function messageText(message: AgentMessage): string {
  if (message.role === "bashExecution") return message.output;
  if (message.role === "branchSummary" || message.role === "compactionSummary")
    return message.summary;
  if (message.role === "custom" || message.role === "user") {
    if (typeof message.content === "string") return message.content;
  }
  if ("content" in message && Array.isArray(message.content)) {
    return message.content
      .map((block) => {
        if (!isRecord(block)) return "";
        if (block.type === "text" && typeof block.text === "string")
          return block.text;
        if (block.type === "thinking" && typeof block.thinking === "string")
          return block.thinking;
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

function toolCalls(
  messages: readonly DecayMessageInput[],
): Map<string, ToolCallInfo> {
  const calls = new Map<string, ToolCallInfo>();
  messages.forEach((input, messageIndex) => {
    if (input.message.role !== "assistant") return;
    for (const block of input.message.content) {
      if (block.type !== "toolCall") continue;
      calls.set(block.id, {
        id: block.id,
        name: block.name,
        arguments: isRecord(block.arguments) ? block.arguments : {},
        messageIndex,
      });
    }
  });
  return calls;
}

function findArtifactUri(value: unknown, depth = 0): string | null {
  if (depth > 5) return null;
  if (typeof value === "string") {
    return (
      value.match(/context:\/\/[a-f0-9]{24}\/[a-z0-9][a-z0-9_-]{0,79}/i)?.[0] ??
      null
    );
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findArtifactUri(item, depth + 1);
      if (found !== null) return found;
    }
    return null;
  }
  if (isRecord(value)) {
    for (const item of Object.values(value)) {
      const found = findArtifactUri(item, depth + 1);
      if (found !== null) return found;
    }
  }
  return null;
}

function referenceFor(
  input: DecayMessageInput,
  sessionId: string,
): RecallReference | null {
  const message = input.message;
  const artifact =
    input.artifactUri ??
    findArtifactUri("details" in message ? message.details : undefined) ??
    findArtifactUri(messageText(message));
  if (artifact !== null) return { kind: "artifact", uri: artifact, artifact };
  if (input.entryId === undefined || input.entryRecallable !== true)
    return null;
  return {
    kind: "session-entry",
    uri: `session-entry://${encodeURIComponent(sessionId)}/${encodeURIComponent(input.entryId)}`,
    sessionId,
    entryId: input.entryId,
  };
}

/**
 * Context messages do not carry session entry IDs. For unmatched messages the
 * adapter uses this content-based identity: role + canonical payload digest +
 * ordinal among earlier identical payloads. Appending later messages does not
 * change existing identities.
 */
export function mapMessageIdentities(context: DecayContext): readonly string[] {
  const occurrences = new Map<string, number>();
  return context.messages.map((input) => {
    if (input.entryId !== undefined) {
      const base = `entry:${input.entryId}`;
      const ordinal = occurrences.get(base) ?? 0;
      occurrences.set(base, ordinal + 1);
      return ordinal === 0 ? base : `${base}:${ordinal}`;
    }
    if (input.message.role === "toolResult")
      return `tool-result:${input.message.toolCallId}`;
    const base = `${input.message.role}:${compactDigest(canonical(input.message))}`;
    const ordinal = occurrences.get(base) ?? 0;
    occurrences.set(base, ordinal + 1);
    return `synthetic:${base}:${ordinal}`;
  });
}

function indexMessages(context: DecayContext): readonly IndexedMessage[] {
  const calls = toolCalls(context.messages);
  const identities = mapMessageIdentities(context);
  return context.messages.map((input, index) => {
    const message = input.message;
    return {
      input,
      identity: identities[index] as string,
      index,
      tokens: estimateDecayTokens(message),
      text: messageText(message),
      tool:
        message.role === "toolResult"
          ? (calls.get(message.toolCallId) ?? null)
          : null,
      recall: referenceFor(input, context.sessionId),
    };
  });
}

function normalizeConfig(input: Partial<DecayConfig> | undefined): DecayConfig {
  const positive = (value: number | undefined, fallback: number) =>
    typeof value === "number" && Number.isFinite(value) && value > 0
      ? Math.floor(value)
      : fallback;
  const maximum = input?.maximumWireTokens;
  return {
    protectedRecentTokens: positive(
      input?.protectedRecentTokens,
      DEFAULT_DECAY_CONFIG.protectedRecentTokens,
    ),
    oldLargeResultTokens: positive(
      input?.oldLargeResultTokens,
      DEFAULT_DECAY_CONFIG.oldLargeResultTokens,
    ),
    minimumReplacementSavingsTokens: positive(
      input?.minimumReplacementSavingsTokens,
      DEFAULT_DECAY_CONFIG.minimumReplacementSavingsTokens,
    ),
    maximumWireTokens:
      maximum === null ||
      (typeof maximum === "number" && Number.isFinite(maximum) && maximum > 0)
        ? maximum === null
          ? null
          : Math.floor(maximum)
        : DEFAULT_DECAY_CONFIG.maximumWireTokens,
    pinnedIdentities: Object.freeze([
      ...(input?.pinnedIdentities ?? DEFAULT_DECAY_CONFIG.pinnedIdentities),
    ]),
  };
}

function pathFrom(call: ToolCallInfo): string | null {
  const value =
    call.arguments.path ?? call.arguments.file ?? call.arguments.filePath;
  return typeof value === "string" && value.length > 0 ? value : null;
}

function selectorKey(call: ToolCallInfo): string {
  return canonical(call.arguments);
}

function addProtection(
  protections: Map<string, Set<ProtectionReason>>,
  identity: string,
  reason: ProtectionReason,
): void {
  const reasons = protections.get(identity) ?? new Set<ProtectionReason>();
  reasons.add(reason);
  protections.set(identity, reasons);
}

function buildProtections(
  indexed: readonly IndexedMessage[],
  config: DecayConfig,
): Map<string, Set<ProtectionReason>> {
  const protections = new Map<string, Set<ProtectionReason>>();
  let recent = 0;
  for (
    let index = indexed.length - 1;
    index >= 0 && recent < config.protectedRecentTokens;
    index -= 1
  ) {
    const item = indexed[index] as IndexedMessage;
    recent += item.tokens;
    addProtection(protections, item.identity, "recent-working-set");
  }

  for (const item of indexed) {
    if (item.recall === null)
      addProtection(protections, item.identity, "unrecallable-source");
  }

  const latestReads = new Map<string, IndexedMessage>();
  for (const item of indexed) {
    if (item.tool?.name !== "read") continue;
    const path = pathFrom(item.tool);
    if (path !== null) latestReads.set(path, item);
  }
  for (const item of latestReads.values())
    addProtection(protections, item.identity, "latest-relevant-read");

  const latestUser = [...indexed]
    .reverse()
    .find((item) => item.input.message.role === "user");
  if (latestUser !== undefined)
    addProtection(protections, latestUser.identity, "current-goal-constraints");

  let latestCheckpoint: IndexedMessage | undefined;
  for (const item of indexed) {
    const message = item.input.message;
    if (
      message.role === "compactionSummary" ||
      (message.role === "custom" && CHECKPOINT_NAME.test(message.customType)) ||
      item.input.labels?.some((label) => CHECKPOINT_NAME.test(label)) === true
    ) {
      latestCheckpoint = item;
    }
    if (message.role === "toolResult" && message.isError) {
      addProtection(protections, item.identity, "unresolved-error");
    }
    if (
      item.input.labels?.some((label) => /^(?:pin|pinned)$/i.test(label)) ===
      true
    ) {
      addProtection(protections, item.identity, "explicit-pin");
    }
  }
  if (latestCheckpoint !== undefined) {
    addProtection(
      protections,
      latestCheckpoint.identity,
      "latest-checkpoint-handoff",
    );
  }
  for (const identity of config.pinnedIdentities)
    addProtection(protections, identity, "explicit-pin");

  for (const item of indexed) {
    if (
      item.input.message.role === "assistant" &&
      item.input.message.content.some((block) => block.type === "toolCall")
    ) {
      addProtection(protections, item.identity, "structural-tool-call");
    }
  }
  return protections;
}

function laterConversationalMessage(
  indexed: readonly IndexedMessage[],
  index: number,
): boolean {
  return indexed.slice(index + 1).some((item) => {
    const role = item.input.message.role;
    return role === "assistant" || role === "user";
  });
}

function classifications(
  indexed: readonly IndexedMessage[],
  config: DecayConfig,
): Map<string, DecayClass> {
  const result = new Map<string, DecayClass>();
  const laterReadByPath = new Map<string, IndexedMessage>();
  const laterSearchByKey = new Map<string, IndexedMessage>();
  const laterDigest = new Set<string>();

  for (let index = indexed.length - 1; index >= 0; index -= 1) {
    const item = indexed[index] as IndexedMessage;
    const message = item.input.message;
    const contentDigest = digest(item.text.trim());
    let classification: DecayClass | null = null;

    if (item.tool?.name === "read") {
      const path = pathFrom(item.tool);
      if (path !== null && laterReadByPath.has(path))
        classification = "superseded-read";
      if (path !== null) laterReadByPath.set(path, item);
    } else if (item.tool !== null && SEARCH_TOOLS.has(item.tool.name)) {
      const key = `${item.tool.name}:${selectorKey(item.tool)}`;
      if (laterSearchByKey.has(key)) classification = "superseded-search";
      else if (laterConversationalMessage(indexed, index))
        classification = "consumed-search";
      laterSearchByKey.set(key, item);
    }

    const asyncName =
      message.role === "toolResult"
        ? message.toolName
        : message.role === "custom"
          ? message.customType
          : "";
    if (
      classification === null &&
      ASYNC_NAME.test(asyncName) &&
      laterConversationalMessage(indexed, index)
    ) {
      classification = "acknowledged-async";
    }
    if (classification === null && EMPTY_OUTPUT.test(item.text))
      classification = "empty-output";
    if (
      classification === null &&
      item.text.length > 0 &&
      laterDigest.has(contentDigest)
    )
      classification = "duplicate";
    if (
      classification === null &&
      item.tokens >= config.oldLargeResultTokens &&
      (message.role === "toolResult" ||
        message.role === "custom" ||
        message.role === "bashExecution")
    ) {
      classification = "old-large-result";
    }

    if (classification !== null) result.set(item.identity, classification);
    if (item.text.length > 0) laterDigest.add(contentDigest);
  }
  return result;
}

function toolNameFor(item: IndexedMessage): string {
  const message = item.input.message;
  if (message.role === "toolResult") return message.toolName;
  if (message.role === "custom") return message.customType;
  if (message.role === "bashExecution") return "bash";
  return message.role;
}

function placeholderFor(
  item: IndexedMessage,
  classification: DecayClass,
  recall: RecallReference,
): string {
  const source =
    recall.kind === "artifact"
      ? `artifact ${recall.uri}`
      : `session entry ${recall.entryId}; ${recall.uri}`;
  return `[Context-elided: ${classification}; ${toolNameFor(item)}; ~${item.tokens.toLocaleString("en-US")} tokens; ${source}]`;
}

function protectionRecord(
  protections: Map<string, Set<ProtectionReason>>,
): Readonly<Record<string, readonly ProtectionReason[]>> {
  return Object.freeze(
    Object.fromEntries(
      [...protections.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([identity, reasons]) => [
          identity,
          Object.freeze([...reasons].sort()),
        ]),
    ),
  );
}

export function validateContextSequence(
  messages: readonly AgentMessage[],
): SequenceValidation {
  const errors: string[] = [];
  const calls = new Map<string, number>();
  const results = new Set<string>();
  messages.forEach((message, index) => {
    if (message.role === "assistant") {
      for (const block of message.content) {
        if (block.type !== "toolCall") continue;
        if (calls.has(block.id))
          errors.push(`duplicate tool call ${block.id} at ${index}`);
        calls.set(block.id, index);
      }
    } else if (message.role === "toolResult") {
      const callIndex = calls.get(message.toolCallId);
      if (callIndex === undefined)
        errors.push(
          `tool result ${message.toolCallId} has no preceding call at ${index}`,
        );
      if (results.has(message.toolCallId))
        errors.push(`duplicate tool result ${message.toolCallId} at ${index}`);
      results.add(message.toolCallId);
      if (callIndex !== undefined) {
        const assistant = messages[callIndex];
        if (assistant?.role === "assistant") {
          const call = assistant.content.find(
            (block) =>
              block.type === "toolCall" && block.id === message.toolCallId,
          );
          if (call?.type === "toolCall" && call.name !== message.toolName) {
            errors.push(
              `tool name mismatch for ${message.toolCallId}: ${call.name} != ${message.toolName}`,
            );
          }
        }
      }
    }
  });
  for (const [toolCallId, callIndex] of calls) {
    if (!results.has(toolCallId)) {
      errors.push(`tool call ${toolCallId} at ${callIndex} has no result`);
    }
  }
  return Object.freeze({
    valid: errors.length === 0,
    errors: Object.freeze(errors),
  });
}

function replaceMessage(
  message: AgentMessage,
  placeholder: string,
): AgentMessage {
  if (message.role === "toolResult")
    return { ...message, content: [{ type: "text", text: placeholder }] };
  if (message.role === "custom") return { ...message, content: placeholder };
  if (message.role === "bashExecution")
    return { ...message, output: placeholder };
  return message;
}

function orderingFingerprint(message: AgentMessage): string {
  if (message.role === "assistant") {
    return canonical({
      role: message.role,
      api: message.api,
      provider: message.provider,
      model: message.model,
      calls: message.content.filter((block) => block.type === "toolCall"),
    });
  }
  if (message.role === "toolResult") {
    return canonical({
      role: message.role,
      toolCallId: message.toolCallId,
      toolName: message.toolName,
      isError: message.isError,
    });
  }
  return canonical({ role: message.role });
}

function validateTransformation(
  original: readonly AgentMessage[],
  output: readonly AgentMessage[],
): SequenceValidation {
  const errors = [...validateContextSequence(output).errors];
  if (original.length !== output.length) errors.push("message count changed");
  const length = Math.min(original.length, output.length);
  for (let index = 0; index < length; index += 1) {
    if (
      orderingFingerprint(original[index] as AgentMessage) !==
      orderingFingerprint(output[index] as AgentMessage)
    ) {
      errors.push(`provider/order structure changed at ${index}`);
    }
  }
  return Object.freeze({
    valid: errors.length === 0,
    errors: Object.freeze(errors),
  });
}

function accounting(
  resident: number,
  replacements: readonly Replacement[],
): DecayAccounting {
  const saved = replacements.reduce(
    (sum, replacement) => sum + replacement.tokensSaved,
    0,
  );
  return Object.freeze({
    residentTokens: resident,
    effectiveWireTokens: Math.max(0, resident - saved),
    proposedTokensSaved: saved,
    residentSource: "message-estimate",
    wireSource: "message-estimate",
  });
}

function epochFor(
  context: DecayContext,
  replacements: readonly Replacement[],
): DecayEpoch {
  const ordered = [...replacements].sort(
    (left, right) =>
      left.messageIndex - right.messageIndex ||
      left.identity.localeCompare(right.identity),
  );
  const plannedContextDigest = digest(
    canonical(context.messages.map((item) => item.message)),
  );
  const seed = canonical({
    schemaVersion: 1,
    sessionId: context.sessionId,
    modelKey: context.modelKey,
    contextGeneration: context.contextGeneration,
    plannedContextDigest,
    replacements: ordered.map((item) => ({
      identity: item.identity,
      digest: item.originalDigest,
      placeholder: item.placeholder,
    })),
  });
  return Object.freeze({
    schemaVersion: 1,
    id: `decay-${digest(seed).slice(0, 24)}`,
    sessionId: context.sessionId,
    modelKey: context.modelKey,
    contextGeneration: context.contextGeneration,
    replacements: Object.freeze(
      Object.fromEntries(
        ordered.map((item) => [item.identity, Object.freeze(item)]),
      ),
    ),
    replacementOrder: Object.freeze(ordered.map((item) => item.identity)),
    plannedContextDigest,
  });
}

function currentTurnTokens(indexed: readonly IndexedMessage[]): number {
  let start = 0;
  for (let index = indexed.length - 1; index >= 0; index -= 1) {
    if (indexed[index]?.input.message.role === "user") {
      start = index;
      break;
    }
  }
  return indexed.slice(start).reduce((sum, item) => sum + item.tokens, 0);
}

export function planContextDecay(
  context: DecayContext,
  inputConfig?: Partial<DecayConfig>,
): DecayPlan {
  const config = normalizeConfig(inputConfig);
  const indexed = indexMessages(context);
  const resident = indexed.reduce((sum, item) => sum + item.tokens, 0);
  const inputValidation = validateContextSequence(
    indexed.map((item) => item.input.message),
  );
  const protections = buildProtections(indexed, config);
  const classes = classifications(indexed, config);
  const candidates: CandidateDecision[] = [];
  const replacements: Replacement[] = [];

  for (const item of indexed) {
    const classification = classes.get(item.identity);
    if (classification === undefined) continue;
    const protectedBy = Object.freeze(
      [...(protections.get(item.identity) ?? [])].sort(),
    );
    const recoverable = item.recall !== null;
    const placeholder = recoverable
      ? placeholderFor(item, classification, item.recall as RecallReference)
      : "";
    const placeholderTokens = recoverable
      ? estimateDecayTokens(placeholder)
      : 0;
    const tokensSaved = Math.max(0, item.tokens - placeholderTokens);
    const blockedReason =
      protectedBy.length > 0
        ? "protected"
        : !recoverable
          ? "unrecoverable"
          : tokensSaved < config.minimumReplacementSavingsTokens
            ? "below-savings-floor"
            : null;
    const selected = inputValidation.valid && blockedReason === null;
    candidates.push(
      Object.freeze({
        identity: item.identity,
        messageIndex: item.index,
        classification,
        estimatedTokens: item.tokens,
        protectedBy,
        recoverable,
        selected,
        blockedReason,
      }),
    );
    if (selected && item.recall !== null) {
      replacements.push(
        Object.freeze({
          identity: item.identity,
          messageIndex: item.index,
          classification,
          toolName: toolNameFor(item),
          originalTokens: item.tokens,
          placeholderTokens,
          tokensSaved,
          originalDigest: digest(canonical(item.input.message)),
          placeholder,
          recall: Object.freeze(item.recall),
        }),
      );
    }
  }

  const epoch = epochFor(context, replacements);
  const applied = applyDecayEpoch(context, epoch);
  const oversizedTurn =
    currentTurnTokens(indexed) > config.protectedRecentTokens;
  return Object.freeze({
    epoch,
    candidates: Object.freeze(candidates),
    protectedIdentities: protectionRecord(protections),
    accounting: accounting(resident, replacements),
    inputValidation,
    outputValidation: applied.validation,
    oversizedProtectedTurn:
      oversizedTurn &&
      (config.maximumWireTokens === null ||
        applied.accounting.effectiveWireTokens > config.maximumWireTokens),
  });
}

export function applyDecayEpoch(
  context: DecayContext,
  epoch: DecayEpoch,
): DecayedContext {
  const indexed = indexMessages(context);
  const original = indexed.map((item) => item.input.message);
  const resident = indexed.reduce((sum, item) => sum + item.tokens, 0);
  const identityErrors: string[] = [];
  if (epoch.sessionId !== context.sessionId)
    identityErrors.push("decay epoch session mismatch");
  if (epoch.modelKey !== context.modelKey)
    identityErrors.push("decay epoch model mismatch");
  if (epoch.contextGeneration !== context.contextGeneration)
    identityErrors.push("decay epoch generation mismatch");
  const applied: Replacement[] = [];
  const candidateOutput =
    identityErrors.length === 0
      ? indexed.map((item) => {
          const replacement = epoch.replacements[item.identity];
          if (replacement === undefined) return item.input.message;
          if (
            replacement.originalDigest !== digest(canonical(item.input.message))
          )
            return item.input.message;
          applied.push(replacement);
          return replaceMessage(item.input.message, replacement.placeholder);
        })
      : original;
  const checked = validateTransformation(original, candidateOutput);
  const errors = Object.freeze([...identityErrors, ...checked.errors]);
  const validation = Object.freeze({ valid: errors.length === 0, errors });
  const output = validation.valid ? candidateOutput : original;
  const replacements = validation.valid ? applied : [];
  return Object.freeze({
    messages: Object.freeze(output),
    epoch,
    accounting: accounting(resident, replacements),
    validation,
    transformation: Object.freeze({
      cacheEpochId: epoch.id,
      inputFingerprint: digest(canonical(original)),
      outputFingerprint: digest(canonical(output)),
      inputMessageCount: original.length,
      outputMessageCount: output.length,
      replacementCount: replacements.length,
    }),
  });
}
