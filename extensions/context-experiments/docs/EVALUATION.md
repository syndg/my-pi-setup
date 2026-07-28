# Phase 9 offline integration evaluation

## Scope and method

This evaluation validates the benchmark contracts for the completed Snapcompact, provider-native compaction, and larger-context model-promotion adapters. It is deliberately **offline**:

- all three adapters run the complete fixed `phase9-wave6-synthetic-v1` corpus;
- each provider-facing seam is an explicitly injected deterministic fake;
- every adapter run sets `providerCallsAllowed: true` so the provider-policy gate is exercised intentionally rather than bypassed;
- no transport, credential lookup, provider SDK, or network request is used;
- the no-op full-context strategy is run as the control;
- each adapter benchmark is run twice and its benchmark ID and rendered JSON report are required to be identical.

The fakes return fixed usage observations and exact corpus-derived evidence. Consequently, fidelity results validate request/response mapping, scoring, fallback routing, and accounting—not OCR quality, provider compaction quality, model quality, latency, pricing, or real token savings.

## Measured offline results

These values were produced by `phase9-integration.test.ts` from the deterministic fakes. Latency, token usage, cache values, and estimated cost for adapter-completed cases are synthetic contract fixtures.

| Strategy | Completed | Explicit fallback | Mean structural fidelity | Mean continuation quality | Latency input (ms) | Input tokens | Output tokens | Images / bytes | Estimated USD |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| No-op full-context control | 5 | 0 | 100 | 100 | 0 | 24,498 | 0 | 1 / 48,000 | unavailable |
| Snapcompact + fake vision evaluator | 3 | 2 | 100 | 100 | 30 | 494 | 30 | 15 / 146,451 | 0.003 |
| Provider compaction + fake client | 3 | 2 | 100 | 100 | 60 | 794 | 60 | 1 / 48,000 | 0.006 |
| Model promotion + fake client | 3 | 2 | 100 | 100 | 90 | 1,094 | 90 | 1 / 48,000 | 0.009 |

For one benchmark pass, each fake provider operation was invoked exactly three times—the three corpus cases whose default environments satisfy the adapter manifest. The remaining two cases were routed to the explicitly supplied no-op fallback:

- Snapcompact: both cases lacked the required `image-input` capability;
- provider compaction: the image-bearing case was rejected as image-incompatible, and the legacy-provider case lacked `provider-compaction`;
- model promotion: both cases lacked one or both promotion requirements.

All fallback results preserved input and retained 100/100 control fidelity. Accounting checks also verify the fake cache epochs and invalidations, including the model-promotion adapter's required additional source-to-target cache invalidation. Snapcompact's 15 reported images comprise 14 generated deterministic bitmap frames for the three executed cases plus the source image accounted by the no-op fallback.

## Interpretation

The lower fake input-token totals relative to the no-op control are **not evidence of a provider advantage**. They are values supplied by deterministic fakes so the accounting pipeline can be checked. Likewise, perfect scores are expected because the fakes return corpus-derived exact evidence; they do not predict live OCR, compaction, or promoted-model behavior.

The validated claims are limited to:

1. the package index exposes each adapter and its injected client/renderer/evaluator seams;
2. explicit provider opt-in, manifest capability checks, and explicit fallback routing compose correctly across the fixed corpus;
3. adapter evidence and measurements map deterministically into benchmark reports;
4. repeated offline runs are byte-deterministic; and
5. the integration introduces no production lifecycle registration or default selection.

## Adoption status

**No experiment is adopted as a production default.** Adoption remains pending a controlled live evaluation that demonstrates a repeatable advantage over the no-op/full-context control (and relevant production baselines) on fidelity, continuation quality, cost, latency, cache behavior, and operational burden. Until then, these adapters remain explicitly constructed, provider-gated experiment paths only.
