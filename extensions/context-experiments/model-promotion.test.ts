import assert from "node:assert/strict";
import test from "node:test";
import {
  FIXED_SYNTHETIC_CORPUS,
  runBenchmark,
  type BenchmarkCase,
  type BenchmarkEnvironment,
  type StrategyOutput,
} from "./src/index.ts";
import {
  createModelPromotionStrategy,
  estimatePromotionInputTokens,
  type PromotionClient,
  type PromotionInvocationRequest,
  type PromotionInvocationResult,
  type PromotionTargetDescriptor,
} from "./src/adapters/model-promotion.ts";

function fixture(id: string): BenchmarkCase {
  const found = FIXED_SYNTHETIC_CORPUS.cases.find(
    (candidate) => candidate.id === id,
  );
  assert.ok(found, `fixture ${id} must exist`);
  return found;
}

function evidence(item: BenchmarkCase): StrategyOutput {
  return {
    preservedFacts: item.facts.map((fact) => ({
      factId: fact.id,
      value: fact.value,
      evidenceRefs: [...fact.evidenceMessageIds],
    })),
    structural: {
      messageOrder: item.messages.map((message) => message.id),
      toolPairs: item.structural.toolPairs.map((pair) => ({ ...pair })),
      artifactUris: [...item.structural.artifactUris],
      unresolvedErrorFactIds: [...item.structural.unresolvedErrorFactIds],
    },
    continuationAnswers: item.continuation.probes.map((probe) => ({
      probeId: probe.id,
      answer: probe.expectedAnswer,
      supportingFactIds: [...probe.expectedFactIds],
    })),
    nextAction: item.continuation.exactNextAction,
  };
}

function result(item: BenchmarkCase): PromotionInvocationResult {
  return {
    evidence: evidence(item),
    latencyMs: 37,
    usage: {
      inputTokens: 911,
      outputTokens: 73,
      cachedInputTokens: 19,
      imageTokens: null,
      estimatedCostUsd: 0.0042,
    },
    cache: {
      cacheablePrefixTokens: 850,
      cacheReadTokens: 19,
      cacheWriteTokens: 832,
      invalidations: 2,
      epochId: "target-epoch-7",
    },
  };
}

const baseTarget: PromotionTargetDescriptor = {
  providerId: "synthetic/full-capability",
  modelId: "synthetic-1m",
  contextWindowTokens: 1_000_000,
  acceptsImages: true,
  tools: [
    {
      name: "read",
      inputSchema: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
        additionalProperties: false,
      },
    },
    {
      name: "bash",
      inputSchema: {
        type: "object",
        properties: { command: { type: "string" } },
        required: ["command"],
        additionalProperties: false,
      },
    },
    {
      name: "rg",
      inputSchema: {
        type: "object",
        properties: { pattern: { type: "string" }, path: { type: "string" } },
        required: ["pattern", "path"],
        additionalProperties: false,
      },
    },
  ],
};

function client(overrides: Partial<PromotionClient> = {}): PromotionClient {
  return {
    hasProviderAuth: async () => true,
    isModelAvailable: async () => true,
    promote: async (request) => result(request.fixture),
    ...overrides,
  };
}

function environment(
  overrides: Partial<BenchmarkEnvironment> = {},
): BenchmarkEnvironment {
  return {
    providerId: "synthetic/full-capability",
    modelId: "synthetic-272k",
    contextWindowTokens: 272_000,
    capabilities: [
      "model-promotion",
      "larger-context-window",
      "image-input",
      "token-usage",
      "cache-metrics",
    ],
    ...overrides,
  };
}

async function execute(
  item: BenchmarkCase,
  options: {
    readonly target?: PromotionTargetDescriptor;
    readonly client?: PromotionClient;
    readonly environment?: BenchmarkEnvironment;
    readonly estimateInputTokens?: (fixture: BenchmarkCase) => number;
  } = {},
) {
  const strategy = createModelPromotionStrategy({
    target: options.target ?? baseTarget,
    client: options.client ?? client(),
    ...(options.estimateInputTokens
      ? { estimateInputTokens: options.estimateInputTokens }
      : {}),
  });
  return strategy.execute({
    fixture: item,
    environment: options.environment ?? environment(),
    providerCallsAllowed: true,
  });
}

test("manifest is provider-gated and requires both promotion capabilities", async () => {
  let calls = 0;
  const strategy = createModelPromotionStrategy({
    target: baseTarget,
    client: client({
      promote: async (request) => {
        calls += 1;
        return result(request.fixture);
      },
    }),
  });
  assert.equal(strategy.manifest.execution, "provider");
  assert.deepEqual(
    strategy.manifest.requirements.map((requirement) => requirement.capability),
    ["model-promotion", "larger-context-window"],
  );

  const blocked = await runBenchmark({
    strategy,
    corpus: {
      schemaVersion: "context-experiment-corpus/v1",
      id: "promotion-gate",
      description: "gate",
      cases: [fixture("compaction-continuation")],
    },
  });
  assert.equal(calls, 0);
  assert.equal(blocked.results[0]?.failureFallback.primaryOutcome, "blocked");
  assert.equal(
    blocked.results[0]?.failureFallback.failureCode,
    "provider-calls-disabled",
  );

  const missingCapability = await runBenchmark({
    strategy,
    corpus: {
      schemaVersion: "context-experiment-corpus/v1",
      id: "promotion-capability",
      description: "capability",
      cases: [fixture("compaction-continuation")],
    },
    providerCallsAllowed: true,
    environmentForCase: () =>
      environment({ capabilities: ["model-promotion"] }),
  });
  assert.equal(calls, 0);
  assert.deepEqual(
    missingCapability.results[0]?.providerCompatibility.missingCapabilities,
    ["larger-context-window"],
  );
});

test("preflight rejects target, auth, tool, image, fit, and availability incompatibilities before invocation", async () => {
  let invocations = 0;
  const item = fixture("state-and-tool-structure");
  const unavailableClient = client({
    isModelAvailable: async () => false,
    promote: async (request) => {
      invocations += 1;
      return result(request.fixture);
    },
  });
  const cases = [
    await execute(item, {
      target: { ...baseTarget, contextWindowTokens: 272_000 },
    }),
    await execute(item, {
      client: client({ hasProviderAuth: async () => false }),
    }),
    await execute(item, {
      target: {
        ...baseTarget,
        tools: baseTarget.tools.filter((tool) => tool.name !== "bash"),
      },
    }),
    await execute(fixture("unsupported-image-input"), {
      target: { ...baseTarget, acceptsImages: false },
    }),
    await execute(item, {
      target: { ...baseTarget, contextWindowTokens: 272_001 },
      environment: environment({ contextWindowTokens: 272_000 }),
      estimateInputTokens: () => 272_002,
    }),
    await execute(item, { client: unavailableClient }),
  ];
  assert.deepEqual(
    cases.map((execution) => execution.failure?.code),
    [
      "promotion-target-not-larger",
      "promotion-provider-auth-missing",
      "promotion-tool-schema-incompatible",
      "promotion-image-unsupported",
      "promotion-context-does-not-fit",
      "promotion-model-unavailable",
    ],
  );
  assert.ok(cases.every((execution) => execution.outcome === "unsupported"));
  assert.ok(
    cases.every((execution) => execution.failure?.inputPreserved === true),
  );
  assert.equal(invocations, 0);
});

test("successful promotion invokes only the explicit target with a non-destructive fixture copy", async () => {
  const item = fixture("compaction-continuation");
  const before = JSON.stringify(item);
  let captured: PromotionInvocationRequest | undefined;
  const strategy = createModelPromotionStrategy({
    target: baseTarget,
    client: client({
      promote: async (request) => {
        captured = request;
        const mutable = request.fixture as unknown as {
          messages: Array<{ text?: string }>;
        };
        mutable.messages[0]!.text = "client-local mutation";
        return result(item);
      },
    }),
  });
  const execution = await strategy.execute({
    fixture: item,
    environment: environment(),
    providerCallsAllowed: true,
  });
  assert.equal(execution.outcome, "completed");
  assert.deepEqual(captured?.target, baseTarget);
  assert.notEqual(captured?.fixture, item);
  assert.equal(JSON.stringify(item), before);
  assert.equal(execution.output?.nextAction, item.continuation.exactNextAction);
});

test("invocation failure is input-preserving and states rollback and fallback behavior", async () => {
  const execution = await execute(fixture("compaction-continuation"), {
    client: client({
      promote: async () => {
        throw new Error("provider disconnected after accepting request");
      },
    }),
  });
  assert.equal(execution.outcome, "failed");
  assert.equal(execution.failure?.code, "promotion-invocation-failed");
  assert.equal(execution.failure?.inputPreserved, true);
  assert.match(
    execution.failure?.message ?? "",
    /no production model or default was changed/i,
  );
  assert.match(
    execution.failure?.suggestedFallback ?? "",
    /source model.*explicit fallback/i,
  );
});

test("usage, image, cache invalidation, cost, and latency accounting map to benchmark measurements", async () => {
  const item = fixture("unsupported-image-input");
  const strategy = createModelPromotionStrategy({
    target: baseTarget,
    client: client(),
  });
  const report = await runBenchmark({
    strategy,
    corpus: {
      schemaVersion: "context-experiment-corpus/v1",
      id: "promotion-accounting",
      description: "accounting",
      cases: [item],
    },
    providerCallsAllowed: true,
    environmentForCase: () => environment(),
  });
  const measured = report.results[0];
  assert.equal(measured?.structuralFidelity.score, 100);
  assert.equal(measured?.continuationQuality.score, 100);
  assert.equal(measured?.latencyMs, 37);
  assert.deepEqual(measured?.costInput, {
    inputTokens: 911,
    outputTokens: 73,
    cachedInputTokens: 19,
    imageCount: 1,
    imageBytes: 48_000,
    imageTokens: null,
    estimatedCostUsd: 0.0042,
  });
  assert.deepEqual(measured?.cacheInput, {
    cacheablePrefixTokens: 850,
    cacheReadTokens: 19,
    cacheWriteTokens: 832,
    invalidations: 3,
    epochId: "target-epoch-7",
  });
  assert.ok(estimatePromotionInputTokens(item) > 0);
});

test("invalid concrete tool arguments are rejected by the target JSON schema", async () => {
  const item = structuredClone(fixture("state-and-tool-structure"));
  const firstCall = item.messages.find((message) => message.toolCalls)
    ?.toolCalls?.[0];
  assert.ok(firstCall);
  (firstCall as unknown as { arguments: Record<string, unknown> }).arguments = {
    path: 42,
  };
  const execution = await execute(item);
  assert.equal(execution.outcome, "unsupported");
  assert.equal(execution.failure?.code, "promotion-tool-schema-incompatible");
});
