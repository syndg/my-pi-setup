# Snapcompact experiment adapter

Snapcompact is a Phase 9 benchmark adapter behind the existing `ExperimentStrategy` seam. It renders provider-neutral transcript text, tool calls, tool results, and image descriptors into deterministic PNG frames, then asks an explicitly injected vision evaluator for evidence. It does not register a Pi hook, select a provider/model, persist artifacts, or become a production/default compaction strategy.

The adapter is intentionally imported directly because the shared package index is outside this experiment's ownership:

```ts
import { createSnapcompactStrategy } from "../src/adapters/snapcompact.ts";

const strategy = createSnapcompactStrategy({
  evaluator: myVisionEvaluator,
});

const report = await runBenchmark({
  strategy,
  corpus,
  providerCallsAllowed: true,
});
```

There is no exported strategy singleton. A strategy cannot be created with provider access unless the caller supplies a `VisionEvaluator`, and both the runner and adapter require the explicit `providerCallsAllowed` opt-in before `evaluate` can run.

## Manifest and capability behavior

The stable manifest declares:

- `execution: "provider"`;
- `acceptsImages: true`;
- required capability `image-input`;
- no mandatory token-usage or cache-metrics capability;
- zero package dependencies and no production lifecycle.

The runner blocks execution before rendering when provider calls are disabled or the selected environment lacks image input. Image-bearing benchmark messages are accepted. Because corpus images contain provider-neutral descriptors rather than image payload bytes, their ID, MIME type, declared bytes, and alt text are rendered as indexed source material and exposed to the evaluator as `sourceImages`.

## Deterministic frames

`createDeterministicSnapcompactRenderer` uses only Node built-ins (`node:crypto` and `node:zlib`). For each message, it creates stable source entries for:

1. message text;
2. each tool call and canonicalized argument object;
3. each tool result, including full content, error state, call ID, and explicit artifact URI;
4. each source image descriptor.

Entries are wrapped and paginated by fixed character-cell dimensions. A bundled 5×7 bitmap alphabet renders the pixels into 8-bit grayscale PNGs. PNG chunks include deterministic CRC-32 values and zlib-compressed scanlines. Identical fixtures and renderer options produce identical frame IDs, bytes, SHA-256 values, text-index entries, and artifact references.

The text index retains stable entry ID, ordinal, source message/role/kind, UTF-8 byte length, text SHA-256, containing frame IDs, and artifact URIs. Artifact references separately map each `context://` URI to source message IDs and text-index IDs. The original fixture remains untouched in memory and is available to the benchmark-only fallback path.

The bundled font deliberately favors determinism and portability over typography: lowercase ASCII is visually rendered with its uppercase glyph, while the index hashes the exact original text. Callers may inject a `SnapcompactFrameRenderer` for a higher-fidelity renderer without changing the strategy or runner.

## Vision evaluator contract

`VisionEvaluator.evaluate` receives:

- the selected fixture/environment identity;
- PNG frames;
- stable text index and artifact references;
- source message order and image descriptors;
- a fact catalog containing IDs, categories, and source message IDs, but **not expected fact values**;
- continuation probe IDs/prompts, but **not expected answers**;
- the optional abort signal.

The evaluator returns observed fact evidence keyed by text-index IDs, structural evidence, continuation answers, exact next action, and provider usage. The adapter maps text-index IDs back to source message IDs for `PreservedFact.evidenceRefs` and freezes the resulting `StrategyOutput`. The runner remains the only component that scores fidelity and continuation quality.

## Measurements

For completed and input-preserving fallback executions, the adapter reports:

- renderer latency plus evaluator-observed latency;
- provider input, output, and cached input tokens;
- generated frame count as `imageCount`;
- exact sum of generated PNG bytes as `imageBytes`;
- evaluator/provider image tokens, or `null` when unavailable;
- estimated USD, or `null` when unavailable;
- evaluator-observed cache prefix/read/write/invalidation/epoch values.

The deterministic renderer reports zero latency rather than introducing wall-clock nondeterminism. An injected renderer may report an observed value. If provider accounting is unavailable after a thrown evaluator call, unknown image tokens and cost remain `null`; already-rendered frame count/bytes are still accounted.

## Failure and text fallback

The adapter preserves the original provider-neutral fixture and returns an explicit benchmark text fallback for experimental-path failures:

| Failure | Stable code | Behavior |
| --- | --- | --- |
| Renderer throws | `snapcompact-render-failed` | No evaluator call; lossless text output; zero generated-image accounting |
| Evaluator throws/fails | `snapcompact-evaluator-failed` | Lossless text output; account rendered frames and any returned usage |
| Evaluator reports OCR failure | `snapcompact-ocr-failed` | Lossless text output; account rendered frames and returned usage |

These executions use `outcome: "fallback"`, include `inputPreserved: true`, and state the textual fallback explicitly in `suggestedFallback`. The fallback is local benchmark evidence projection from the unchanged fixture; it does not alter a transcript or install a production policy. Provider-policy and capability blocks remain `unsupported` and are handled by the runner's separately supplied fallback strategy, if any.

## Focused validation

```bash
node --test --experimental-strip-types snapcompact.test.ts
PATH=/Volumes/External/Coding/pi-mono-fullscreen/node_modules/.bin:$PATH tsc --noEmit -p .
```

The focused suite covers byte-deterministic valid PNGs, stable index/artifact references, evidence-to-output fidelity, runner capability and provider-call gates, image/cost/cache accounting, source image acceptance, and render/evaluator/OCR fallback behavior.
