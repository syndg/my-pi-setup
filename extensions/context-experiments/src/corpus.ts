import type { BenchmarkCorpus, BenchmarkEnvironment } from "./types.ts";

const FULL_CAPABILITIES = Object.freeze([
  "image-input",
  "provider-compaction",
  "model-promotion",
  "larger-context-window",
  "token-usage",
  "cache-metrics",
] as const);

const FULL_ENVIRONMENT: BenchmarkEnvironment = Object.freeze({
  providerId: "synthetic/full-capability",
  modelId: "synthetic-272k",
  contextWindowTokens: 272_000,
  capabilities: FULL_CAPABILITIES,
});

const TEXT_ONLY_ENVIRONMENT: BenchmarkEnvironment = Object.freeze({
  providerId: "synthetic/text-only",
  modelId: "synthetic-128k-text",
  contextWindowTokens: 128_000,
  capabilities: Object.freeze(["token-usage"] as const),
});

const UNSUPPORTED_PROVIDER_ENVIRONMENT: BenchmarkEnvironment = Object.freeze({
  providerId: "synthetic/local-legacy",
  modelId: "synthetic-32k",
  contextWindowTokens: 32_000,
  capabilities: Object.freeze([]),
});

function longToolOutput() {
  const rows = Array.from({ length: 900 }, (_, index) => {
    const row = String(index + 1).padStart(4, "0");
    return `${row}: packages/core/src/generated-${row}.ts: deterministic diagnostic payload; status=ok; shard=benchmark`;
  });
  rows[731] =
    "0732: packages/core/src/overflow.ts: ERROR E_CONTEXT_LIMIT retained tool result exceeds safe wire limit";
  return `${rows.join("\n")}\nFull output: context://0123456789abcdef01234567/tool-long-output`;
}

export const SYNTHETIC_LONG_TOOL_OUTPUT = longToolOutput();

/** Fixed, provider-neutral Phase 9 corpus. No fixture construction performs I/O. */
export const FIXED_SYNTHETIC_CORPUS = Object.freeze({
  schemaVersion: "context-experiment-corpus/v1",
  id: "phase9-wave6-synthetic-v1",
  description:
    "Fixed synthetic coding-session corpus for context strategy comparisons.",
  cases: Object.freeze([
    Object.freeze({
      id: "state-and-tool-structure",
      title:
        "Goals, constraints, decisions, files, errors, pairs, and artifacts",
      tags: Object.freeze(["state", "tool-pairing", "artifact", "error"]),
      messages: Object.freeze([
        Object.freeze({
          id: "m-state-user",
          role: "user",
          text: "Goal: ship the parser without changing public defaults. Constraint: edit only src/parser.ts and tests/parser.test.ts. Preserve the durable transcript.",
        }),
        Object.freeze({
          id: "m-state-calls",
          role: "assistant",
          text: "Inspect the parser and focused tests.",
          toolCalls: Object.freeze([
            Object.freeze({
              id: "call-read-parser",
              name: "read",
              arguments: Object.freeze({ path: "src/parser.ts" }),
            }),
            Object.freeze({
              id: "call-run-test",
              name: "bash",
              arguments: Object.freeze({ command: "npm test -- parser" }),
            }),
          ]),
        }),
        Object.freeze({
          id: "m-state-read-result",
          role: "tool-result",
          toolResult: Object.freeze({
            callId: "call-read-parser",
            name: "read",
            content:
              "src/parser.ts uses strict JSON parsing. Full source: context://aaaaaaaaaaaaaaaaaaaaaaaa/parser-source",
            isError: false,
            artifactUri: "context://aaaaaaaaaaaaaaaaaaaaaaaa/parser-source",
          }),
        }),
        Object.freeze({
          id: "m-state-test-result",
          role: "tool-result",
          toolResult: Object.freeze({
            callId: "call-run-test",
            name: "bash",
            content:
              "FAIL tests/parser.test.ts: expected malformed-json but received unknown-field (E_ASSERT_17)",
            isError: true,
            artifactUri: "context://bbbbbbbbbbbbbbbbbbbbbbbb/parser-test-log",
          }),
        }),
        Object.freeze({
          id: "m-state-checkpoint",
          role: "checkpoint",
          text: "Decision: keep strict exact-key validation because callers must not guess. Changed file: src/parser.ts (modified). Next: update tests/parser.test.ts to expect unknown-field, then rerun npm test -- parser.",
        }),
      ]),
      facts: Object.freeze([
        Object.freeze({
          id: "fact-goal-parser",
          category: "goal",
          value: "Ship the parser without changing public defaults.",
          weight: 4,
          evidenceMessageIds: Object.freeze(["m-state-user"]),
        }),
        Object.freeze({
          id: "fact-constraint-owned",
          category: "constraint",
          value: "Edit only src/parser.ts and tests/parser.test.ts.",
          weight: 4,
          evidenceMessageIds: Object.freeze(["m-state-user"]),
        }),
        Object.freeze({
          id: "fact-constraint-transcript",
          category: "constraint",
          value: "Preserve the durable transcript.",
          weight: 3,
          evidenceMessageIds: Object.freeze(["m-state-user"]),
        }),
        Object.freeze({
          id: "fact-decision-strict",
          category: "decision",
          value:
            "Keep strict exact-key validation because callers must not guess.",
          weight: 3,
          evidenceMessageIds: Object.freeze(["m-state-checkpoint"]),
        }),
        Object.freeze({
          id: "fact-file-parser",
          category: "file",
          value: "src/parser.ts is modified.",
          weight: 3,
          evidenceMessageIds: Object.freeze(["m-state-checkpoint"]),
        }),
        Object.freeze({
          id: "fact-error-assert17",
          category: "error",
          value:
            "E_ASSERT_17: expected malformed-json but received unknown-field.",
          weight: 4,
          evidenceMessageIds: Object.freeze(["m-state-test-result"]),
        }),
        Object.freeze({
          id: "fact-pair-read",
          category: "tool-pairing",
          value: "call-read-parser pairs read with m-state-read-result.",
          weight: 2,
          evidenceMessageIds: Object.freeze([
            "m-state-calls",
            "m-state-read-result",
          ]),
        }),
        Object.freeze({
          id: "fact-artifact-parser",
          category: "artifact-reference",
          value: "context://aaaaaaaaaaaaaaaaaaaaaaaa/parser-source",
          weight: 3,
          evidenceMessageIds: Object.freeze(["m-state-read-result"]),
        }),
        Object.freeze({
          id: "fact-next-parser",
          category: "next-action",
          value:
            "Update tests/parser.test.ts to expect unknown-field, then rerun npm test -- parser.",
          weight: 4,
          evidenceMessageIds: Object.freeze(["m-state-checkpoint"]),
        }),
      ]),
      structural: Object.freeze({
        requiredMessageOrder: Object.freeze([
          "m-state-user",
          "m-state-calls",
          "m-state-read-result",
          "m-state-test-result",
          "m-state-checkpoint",
        ]),
        toolPairs: Object.freeze([
          Object.freeze({
            callMessageId: "m-state-calls",
            resultMessageId: "m-state-read-result",
            callId: "call-read-parser",
            toolName: "read",
          }),
          Object.freeze({
            callMessageId: "m-state-calls",
            resultMessageId: "m-state-test-result",
            callId: "call-run-test",
            toolName: "bash",
          }),
        ]),
        artifactUris: Object.freeze([
          "context://aaaaaaaaaaaaaaaaaaaaaaaa/parser-source",
          "context://bbbbbbbbbbbbbbbbbbbbbbbb/parser-test-log",
        ]),
        unresolvedErrorFactIds: Object.freeze(["fact-error-assert17"]),
      }),
      continuation: Object.freeze({
        probes: Object.freeze([
          Object.freeze({
            id: "probe-parser-goal",
            prompt: "What is the current goal?",
            expectedFactIds: Object.freeze(["fact-goal-parser"]),
            expectedAnswer: "Ship the parser without changing public defaults.",
            weight: 3,
          }),
          Object.freeze({
            id: "probe-parser-failure",
            prompt: "What exact failure remains?",
            expectedFactIds: Object.freeze(["fact-error-assert17"]),
            expectedAnswer:
              "E_ASSERT_17: expected malformed-json but received unknown-field.",
            weight: 4,
          }),
          Object.freeze({
            id: "probe-parser-decision",
            prompt: "Which validation decision must be preserved?",
            expectedFactIds: Object.freeze(["fact-decision-strict"]),
            expectedAnswer:
              "Keep strict exact-key validation because callers must not guess.",
            weight: 3,
          }),
        ]),
        exactNextAction:
          "Update tests/parser.test.ts to expect unknown-field, then rerun npm test -- parser.",
      }),
      defaultEnvironment: FULL_ENVIRONMENT,
    }),
    Object.freeze({
      id: "long-tool-output",
      title: "Oversized recoverable tool output",
      tags: Object.freeze(["large-output", "artifact", "error"]),
      messages: Object.freeze([
        Object.freeze({
          id: "m-long-user",
          role: "user",
          text: "Find the context-limit regression, but keep the complete diagnostic recoverable.",
        }),
        Object.freeze({
          id: "m-long-call",
          role: "assistant",
          toolCalls: Object.freeze([
            Object.freeze({
              id: "call-long-rg",
              name: "rg",
              arguments: Object.freeze({
                pattern: "ERROR|status",
                path: "packages",
              }),
            }),
          ]),
        }),
        Object.freeze({
          id: "m-long-result",
          role: "tool-result",
          toolResult: Object.freeze({
            callId: "call-long-rg",
            name: "rg",
            content: SYNTHETIC_LONG_TOOL_OUTPUT,
            isError: false,
            artifactUri: "context://0123456789abcdef01234567/tool-long-output",
          }),
        }),
        Object.freeze({
          id: "m-long-checkpoint",
          role: "checkpoint",
          text: "The exact blocker is E_CONTEXT_LIMIT in packages/core/src/overflow.ts. Next: add the dead-end rescue fixture without deleting the archived output.",
        }),
      ]),
      facts: Object.freeze([
        Object.freeze({
          id: "fact-goal-long",
          category: "goal",
          value:
            "Find the context-limit regression while keeping the complete diagnostic recoverable.",
          weight: 3,
          evidenceMessageIds: Object.freeze(["m-long-user"]),
        }),
        Object.freeze({
          id: "fact-error-context-limit",
          category: "error",
          value: "E_CONTEXT_LIMIT in packages/core/src/overflow.ts.",
          weight: 5,
          evidenceMessageIds: Object.freeze([
            "m-long-result",
            "m-long-checkpoint",
          ]),
        }),
        Object.freeze({
          id: "fact-pair-long",
          category: "tool-pairing",
          value: "call-long-rg pairs rg with m-long-result.",
          weight: 2,
          evidenceMessageIds: Object.freeze(["m-long-call", "m-long-result"]),
        }),
        Object.freeze({
          id: "fact-artifact-long",
          category: "artifact-reference",
          value: "context://0123456789abcdef01234567/tool-long-output",
          weight: 5,
          evidenceMessageIds: Object.freeze(["m-long-result"]),
        }),
        Object.freeze({
          id: "fact-next-long",
          category: "next-action",
          value:
            "Add the dead-end rescue fixture without deleting the archived output.",
          weight: 4,
          evidenceMessageIds: Object.freeze(["m-long-checkpoint"]),
        }),
      ]),
      structural: Object.freeze({
        requiredMessageOrder: Object.freeze([
          "m-long-user",
          "m-long-call",
          "m-long-result",
          "m-long-checkpoint",
        ]),
        toolPairs: Object.freeze([
          Object.freeze({
            callMessageId: "m-long-call",
            resultMessageId: "m-long-result",
            callId: "call-long-rg",
            toolName: "rg",
          }),
        ]),
        artifactUris: Object.freeze([
          "context://0123456789abcdef01234567/tool-long-output",
        ]),
        unresolvedErrorFactIds: Object.freeze(["fact-error-context-limit"]),
      }),
      continuation: Object.freeze({
        probes: Object.freeze([
          Object.freeze({
            id: "probe-long-blocker",
            prompt: "What exact blocker was found?",
            expectedFactIds: Object.freeze(["fact-error-context-limit"]),
            expectedAnswer: "E_CONTEXT_LIMIT in packages/core/src/overflow.ts.",
            weight: 4,
          }),
          Object.freeze({
            id: "probe-long-recall",
            prompt: "Where is the full diagnostic?",
            expectedFactIds: Object.freeze(["fact-artifact-long"]),
            expectedAnswer:
              "context://0123456789abcdef01234567/tool-long-output",
            weight: 4,
          }),
        ]),
        exactNextAction:
          "Add the dead-end rescue fixture without deleting the archived output.",
      }),
      defaultEnvironment: FULL_ENVIRONMENT,
    }),
    Object.freeze({
      id: "compaction-continuation",
      title: "Checkpoint-shaped continuation after compaction",
      tags: Object.freeze(["compaction", "continuation", "checkpoint"]),
      messages: Object.freeze([
        Object.freeze({
          id: "m-compact-summary",
          role: "compaction-summary",
          text: "Goal: finish cache epoch validation. Constraint: do not rewrite a deep prefix each turn. Decision: decay only at discrete epochs because stable prefixes preserve cache hits. Changed files: src/cache.ts and tests/cache.test.ts. Blocker: CACHE_EPOCH_MISMATCH after model switch. Artifact: context://cccccccccccccccccccccccc/cache-trace.",
        }),
        Object.freeze({
          id: "m-compact-user",
          role: "user",
          text: "Continue from the checkpoint. Do not reread the whole transcript.",
        }),
        Object.freeze({
          id: "m-compact-checkpoint",
          role: "checkpoint",
          text: "Exact next action: reset the epoch on model switch, then run node --test tests/cache.test.ts.",
        }),
      ]),
      facts: Object.freeze([
        Object.freeze({
          id: "fact-goal-cache",
          category: "goal",
          value: "Finish cache epoch validation.",
          weight: 4,
          evidenceMessageIds: Object.freeze(["m-compact-summary"]),
        }),
        Object.freeze({
          id: "fact-constraint-prefix",
          category: "constraint",
          value: "Do not rewrite a deep prefix each turn.",
          weight: 4,
          evidenceMessageIds: Object.freeze(["m-compact-summary"]),
        }),
        Object.freeze({
          id: "fact-decision-epochs",
          category: "decision",
          value:
            "Decay only at discrete epochs because stable prefixes preserve cache hits.",
          weight: 4,
          evidenceMessageIds: Object.freeze(["m-compact-summary"]),
        }),
        Object.freeze({
          id: "fact-files-cache",
          category: "file",
          value: "Changed files are src/cache.ts and tests/cache.test.ts.",
          weight: 3,
          evidenceMessageIds: Object.freeze(["m-compact-summary"]),
        }),
        Object.freeze({
          id: "fact-error-cache",
          category: "error",
          value: "CACHE_EPOCH_MISMATCH after model switch.",
          weight: 5,
          evidenceMessageIds: Object.freeze(["m-compact-summary"]),
        }),
        Object.freeze({
          id: "fact-artifact-cache",
          category: "artifact-reference",
          value: "context://cccccccccccccccccccccccc/cache-trace",
          weight: 3,
          evidenceMessageIds: Object.freeze(["m-compact-summary"]),
        }),
        Object.freeze({
          id: "fact-next-cache",
          category: "next-action",
          value:
            "Reset the epoch on model switch, then run node --test tests/cache.test.ts.",
          weight: 5,
          evidenceMessageIds: Object.freeze(["m-compact-checkpoint"]),
        }),
      ]),
      structural: Object.freeze({
        requiredMessageOrder: Object.freeze([
          "m-compact-summary",
          "m-compact-user",
          "m-compact-checkpoint",
        ]),
        toolPairs: Object.freeze([]),
        artifactUris: Object.freeze([
          "context://cccccccccccccccccccccccc/cache-trace",
        ]),
        unresolvedErrorFactIds: Object.freeze(["fact-error-cache"]),
      }),
      continuation: Object.freeze({
        probes: Object.freeze([
          Object.freeze({
            id: "probe-cache-decision",
            prompt: "Why are epochs discrete?",
            expectedFactIds: Object.freeze(["fact-decision-epochs"]),
            expectedAnswer:
              "Decay only at discrete epochs because stable prefixes preserve cache hits.",
            weight: 4,
          }),
          Object.freeze({
            id: "probe-cache-files",
            prompt: "Which files changed?",
            expectedFactIds: Object.freeze(["fact-files-cache"]),
            expectedAnswer:
              "Changed files are src/cache.ts and tests/cache.test.ts.",
            weight: 3,
          }),
          Object.freeze({
            id: "probe-cache-blocker",
            prompt: "What blocker remains?",
            expectedFactIds: Object.freeze(["fact-error-cache"]),
            expectedAnswer: "CACHE_EPOCH_MISMATCH after model switch.",
            weight: 5,
          }),
        ]),
        exactNextAction:
          "Reset the epoch on model switch, then run node --test tests/cache.test.ts.",
      }),
      defaultEnvironment: FULL_ENVIRONMENT,
    }),
    Object.freeze({
      id: "unsupported-image-input",
      title: "Image-bearing context on a text-only provider",
      tags: Object.freeze(["image", "unsupported-provider", "fallback"]),
      messages: Object.freeze([
        Object.freeze({
          id: "m-image-user",
          role: "user",
          text: "Preserve the screenshot reference and continue text-first.",
          images: Object.freeze([
            Object.freeze({
              id: "image-terminal-01",
              mimeType: "image/png",
              bytes: 48_000,
              alt: "Terminal screenshot showing IMAGE_OCR_UNAVAILABLE",
            }),
          ]),
        }),
        Object.freeze({
          id: "m-image-checkpoint",
          role: "checkpoint",
          text: "Constraint: the current provider is text-only. Error: IMAGE_OCR_UNAVAILABLE. Next: fall back without dropping the textual checkpoint.",
        }),
      ]),
      facts: Object.freeze([
        Object.freeze({
          id: "fact-goal-image",
          category: "goal",
          value: "Preserve the screenshot reference and continue text-first.",
          weight: 3,
          evidenceMessageIds: Object.freeze(["m-image-user"]),
        }),
        Object.freeze({
          id: "fact-constraint-text-only",
          category: "constraint",
          value: "The current provider is text-only.",
          weight: 4,
          evidenceMessageIds: Object.freeze(["m-image-checkpoint"]),
        }),
        Object.freeze({
          id: "fact-error-image",
          category: "error",
          value: "IMAGE_OCR_UNAVAILABLE.",
          weight: 5,
          evidenceMessageIds: Object.freeze([
            "m-image-user",
            "m-image-checkpoint",
          ]),
        }),
        Object.freeze({
          id: "fact-next-image",
          category: "next-action",
          value: "Fall back without dropping the textual checkpoint.",
          weight: 5,
          evidenceMessageIds: Object.freeze(["m-image-checkpoint"]),
        }),
      ]),
      structural: Object.freeze({
        requiredMessageOrder: Object.freeze([
          "m-image-user",
          "m-image-checkpoint",
        ]),
        toolPairs: Object.freeze([]),
        artifactUris: Object.freeze([]),
        unresolvedErrorFactIds: Object.freeze(["fact-error-image"]),
      }),
      continuation: Object.freeze({
        probes: Object.freeze([
          Object.freeze({
            id: "probe-image-fallback",
            prompt: "How should unsupported image input be handled?",
            expectedFactIds: Object.freeze([
              "fact-constraint-text-only",
              "fact-error-image",
            ]),
            expectedAnswer:
              "Fall back without dropping the textual checkpoint.",
            weight: 5,
          }),
        ]),
        exactNextAction: "Fall back without dropping the textual checkpoint.",
      }),
      defaultEnvironment: TEXT_ONLY_ENVIRONMENT,
    }),
    Object.freeze({
      id: "unsupported-provider-capabilities",
      title: "Provider without native compaction or promotion",
      tags: Object.freeze([
        "unsupported-provider",
        "provider-compaction",
        "model-promotion",
        "fallback",
      ]),
      messages: Object.freeze([
        Object.freeze({
          id: "m-provider-user",
          role: "user",
          text: "Continue safely on the legacy provider; do not assume remote compaction or model promotion.",
        }),
        Object.freeze({
          id: "m-provider-checkpoint",
          role: "checkpoint",
          text: "Decision: capability detection precedes experimental execution. Next: use the local no-op baseline when the requested capability is absent.",
        }),
      ]),
      facts: Object.freeze([
        Object.freeze({
          id: "fact-goal-provider",
          category: "goal",
          value: "Continue safely on the legacy provider.",
          weight: 3,
          evidenceMessageIds: Object.freeze(["m-provider-user"]),
        }),
        Object.freeze({
          id: "fact-constraint-provider",
          category: "constraint",
          value: "Do not assume remote compaction or model promotion.",
          weight: 5,
          evidenceMessageIds: Object.freeze(["m-provider-user"]),
        }),
        Object.freeze({
          id: "fact-decision-capability",
          category: "decision",
          value: "Capability detection precedes experimental execution.",
          weight: 5,
          evidenceMessageIds: Object.freeze(["m-provider-checkpoint"]),
        }),
        Object.freeze({
          id: "fact-next-provider",
          category: "next-action",
          value:
            "Use the local no-op baseline when the requested capability is absent.",
          weight: 5,
          evidenceMessageIds: Object.freeze(["m-provider-checkpoint"]),
        }),
      ]),
      structural: Object.freeze({
        requiredMessageOrder: Object.freeze([
          "m-provider-user",
          "m-provider-checkpoint",
        ]),
        toolPairs: Object.freeze([]),
        artifactUris: Object.freeze([]),
        unresolvedErrorFactIds: Object.freeze([]),
      }),
      continuation: Object.freeze({
        probes: Object.freeze([
          Object.freeze({
            id: "probe-provider-policy",
            prompt: "What gates this experiment?",
            expectedFactIds: Object.freeze([
              "fact-decision-capability",
              "fact-constraint-provider",
            ]),
            expectedAnswer:
              "Capability detection precedes experimental execution.",
            weight: 5,
          }),
        ]),
        exactNextAction:
          "Use the local no-op baseline when the requested capability is absent.",
      }),
      defaultEnvironment: UNSUPPORTED_PROVIDER_ENVIRONMENT,
    }),
  ]),
}) satisfies BenchmarkCorpus;
