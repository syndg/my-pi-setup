# Context overhead baseline — Wave 2 Lane 2

Captured before Phase 3 deferred-tool changes on 2026-07-28.

## Environment

- Pi: `0.82.1`
- Node: `v24.15.0`
- Working directory: `/Users/syndg/.pi/agent/extensions`
- Invocation: offline, ephemeral session, context files disabled
- Extensions and skills: normal global discovery, plus the measurement extension below

The measurement command itself registers only a slash command, not a tool or skill, so it does not alter the measured tool or skill catalogs.

## Method

Tool overhead is measured over the active names in `ctx.getSystemPromptOptions().selectedTools`, joined to `pi.getAllTools()` metadata. For each active tool, the canonical payload is minified JSON containing `name`, `description`, and `parameters`. This is provider-independent and reproducible; provider wire wrappers can add a small varying amount.

Skill overhead uses Pi's exact `formatSkillsForPrompt()` output after filtering `disable-model-invocation` skills. UTF-8 bytes are authoritative. Token figures use Pi's documented conservative `ceil(chars / 4)` heuristic and are estimates, not provider tokenizer counts.

Reproduce with:

```bash
cat > /tmp/pi-context-overhead-measure.ts <<'EOF'
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { formatSkillsForPrompt } from "@earendil-works/pi-coding-agent";

const bytes = (value: string) => Buffer.byteLength(value, "utf8");
const estimateTokens = (value: string) => Math.ceil(value.length / 4);

export default function (pi: ExtensionAPI) {
  pi.registerCommand("context-overhead-measure", {
    description: "Measure active tool and visible skill fixed overhead",
    handler: async (_args, ctx) => {
      const options = ctx.getSystemPromptOptions();
      const activeNames = new Set(options.selectedTools ?? []);
      const activeTools = pi.getAllTools().filter((tool) => activeNames.has(tool.name));
      const rows = activeTools.map((tool) => {
        const description = tool.description ?? "";
        const schema = JSON.stringify(tool.parameters ?? {});
        const canonical = JSON.stringify({
          name: tool.name,
          description,
          parameters: tool.parameters ?? {},
        });
        return {
          name: tool.name,
          descriptionBytes: bytes(description),
          schemaBytes: bytes(schema),
          canonicalBytes: bytes(canonical),
          estimatedTokens: estimateTokens(canonical),
        };
      });
      const skills = options.skills ?? [];
      const visibleSkills = skills.filter((skill) => !skill.disableModelInvocation);
      const skillCatalog = formatSkillsForPrompt(skills);
      console.log(JSON.stringify({
        activeToolCount: activeTools.length,
        registeredToolCount: pi.getAllTools().length,
        tools: {
          descriptionBytes: rows.reduce((n, row) => n + row.descriptionBytes, 0),
          schemaBytes: rows.reduce((n, row) => n + row.schemaBytes, 0),
          canonicalBytes: rows.reduce((n, row) => n + row.canonicalBytes, 0),
          estimatedTokens: rows.reduce((n, row) => n + row.estimatedTokens, 0),
          rows,
        },
        skills: {
          discoveredCount: skills.length,
          visibleCount: visibleSkills.length,
          catalogBytes: bytes(skillCatalog),
          catalogChars: skillCatalog.length,
          estimatedTokens: estimateTokens(skillCatalog),
        },
      }, null, 2));
    },
  });
}
EOF

cd /Users/syndg/.pi/agent/extensions
PI_OFFLINE=1 pi --no-session --no-context-files \
  -e /tmp/pi-context-overhead-measure.ts \
  -p '/context-overhead-measure'
```

## Baseline results

| Metric | Baseline |
|---|---:|
| Registered tools | 22 |
| Initially active tools | 19 |
| Active tool descriptions | 8,667 bytes |
| Active tool parameter schemas | 8,463 bytes |
| Canonical active tool payload | 18,145 bytes |
| Canonical active tool payload estimate | 4,532 tokens |
| Discovered skills | 60 |
| Model-visible skills | 38 |
| Exact visible skill catalog | 20,365 bytes |
| Exact visible skill catalog estimate | 5,087 tokens |
| Combined tool + skill estimate | 9,619 tokens |

### Phase 3 orchestration-tool contribution

| Group | Active tools | Description bytes | Schema bytes | Canonical bytes | Estimated tokens |
|---|---:|---:|---:|---:|---:|
| Background terminals (`bg_*`) | 4 | 1,119 | 777 | 2,095 | 524 |
| Subagents (`subagent_*`) | 7 | 1,603 | 2,219 | 4,212 | 1,056 |
| Workflow | 1 | 3,181 | 622 | 3,871 | 963 |
| Deferred candidates beyond `bg_start` / `subagent_spawn` | 10 | 4,515 | 1,822 | 6,888 | 1,721 |

The deferred-candidate row is the expected initial schema saving before any safe metadata tightening. It includes `workflow`; workflow must remain inactive until raw user input says `ultracode` or explicitly requests a workflow.

## Evaluation notes

- This baseline intentionally measures fixed catalog/schema payload, not conversation messages.
- Cache-hit rate and provider-reported first-request prompt tokens require real provider requests and are deferred to representative-session validation.
- Skill files are outside this lane's ownership, so this phase records their overhead but does not alter skill frontmatter.

## Phase 3 skill-catalog audit — 2026-07-29

Audited all 60 uniquely discovered global skills under `~/.agents/skills` and `~/.pi/agent/skills`, including symlink-resolved duplicates, frontmatter invocation policy, model-facing trigger descriptions, and cross-skill workflow dependencies. The audit used the conservative rule from Pi's skill contract: `disable-model-invocation: true` removes a skill from the model catalog and makes it reachable only through the human-entered `/skill:name` command.

### Before/after skill catalog

The exact baseline command above was run immediately before and after the audit in offline, ephemeral sessions with context files disabled.

| Skill metric | Before audit | After audit | Change |
|---|---:|---:|---:|
| Discovered skills | 60 | 60 | 0 |
| Model-visible skills | 38 | 38 | 0 |
| Exact visible catalog | 20,365 bytes | 20,365 bytes | 0 bytes |
| Exact visible catalog characters | 20,347 | 20,347 | 0 |
| Exact visible catalog estimate | 5,087 tokens | 5,087 tokens | 0 tokens |

No additional skills were disabled. The 22 skills already hidden from model invocation are: `ask-matt`, `batch-grill-me`, `claude-handoff`, `grill-me`, `grill-with-docs`, `handoff`, `implement`, `improve-codebase-architecture`, `loop-me`, `setup-matt-pocock-skills`, `setup-ts-deep-modules`, `teach`, `to-questionnaire`, `to-spec`, `to-tickets`, `triage`, `wayfinder`, `wizard`, `writing-beats`, `writing-fragments`, `writing-great-skills`, and `writing-shape`. Their paired invocation metadata already identifies them as human-only workflows, so their existing frontmatter was left unchanged.

### Rationale

| Decision | Skills | Reason |
|---|---|---|
| Keep automatic file, frontend, browser, and diagnosis discovery | `diagnosing-bugs`, `docx`, `frontend-design`, `impeccable`, `pdf`, `playwright-cli`, `react-doctor`, `vercel-composition-patterns`, `vercel-react-best-practices`, `web-animation-design`, `xlsx` | These are broad automatic domain skills where the user may describe the task without naming the skill. Hiding them would degrade safety, quality, or tool selection. |
| Keep automatic coding/workflow discovery | `codebase-design`, `domain-modeling`, `git-guardrails-claude-code`, `grilling`, `migrate-to-shoehorn`, `mp-code-review`, `pi-update`, `prototype`, `research`, `resolving-merge-conflicts`, `scaffold-exercises`, `setup-pre-commit`, `skill-creator`, `tdd` | Their descriptions contain useful natural-language triggers, and several are autonomous dependencies of other workflows. They are not genuinely manual-only. |
| Keep environment/domain discovery | `cmux`, `synclaw-server`, `youtube-history-db` | These map natural requests to setup-specific capabilities that the model cannot safely infer without catalog metadata. |
| Keep the wiki workflow chain model-visible | `wiki-digest`, `wiki-fetch-readwise-document`, `wiki-fetch-readwise-highlights`, `wiki-import-readwise`, `wiki-ingest`, `wiki-ingest-new`, `wiki-ingest-song`, `wiki-ingest-tweets`, `wiki-ingest-youtube`, `wiki-lint` | The public skills have useful automatic URL/domain triggers, while the fetch helpers are invoked by model-reachable parent skills. Hiding helpers would break the documented cross-skill chain because hidden skills are human-only. |

The presence of a slash alias alone was not treated as proof of manual-only intent. In particular, `react-doctor`, `wiki-ingest-new`, and `wiki-ingest-youtube` mention slash commands but also define valuable automatic triggers; they remain visible. The risk-minimizing outcome is therefore zero additional catalog savings rather than hiding ambiguous or dependency-bearing skills.

## Phase 3 post-change measurement — 2026-07-29

The reproduction command in [Method](#method) was re-run unchanged against the current globally discovered extensions. The run used Pi `0.82.1`, Node `v24.15.0`, `PI_OFFLINE=1`, `--no-session`, and `--no-context-files` from `/Users/syndg/.pi/agent/extensions`. No provider request was made.

Percentage reduction below is `(baseline - post-change) / baseline`; a negative value means growth. Tool token estimates remain the sum of the documented per-tool `ceil(canonical.length / 4)` calculation, and the combined estimate is the tool estimate plus the skill-catalog estimate.

### Initial fixed overhead

| Metric | Baseline | Phase 3 post-change | Change | Reduction |
|---|---:|---:|---:|---:|
| Registered tools | 22 | 24 | +2 | -9.09% |
| Initially active tools | 19 | 11 | -8 | 42.11% |
| Active tool descriptions | 8,667 bytes | 4,461 bytes | -4,206 bytes | 48.53% |
| Active tool parameter schemas | 8,463 bytes | 7,844 bytes | -619 bytes | 7.31% |
| Canonical active tool payload | 18,145 bytes | 12,880 bytes | -5,265 bytes | 29.02% |
| Canonical active tool payload estimate | 4,532 tokens | 3,217 tokens | -1,315 tokens | 29.02% |
| Discovered skills | 60 | 60 | 0 | 0.00% |
| Model-visible skills | 38 | 38 | 0 | 0.00% |
| Exact visible skill catalog | 20,365 bytes | 20,365 bytes | 0 bytes | 0.00% |
| Exact visible skill catalog characters | 20,347 | 20,347 | 0 | 0.00% |
| Exact visible skill catalog estimate | 5,087 tokens | 5,087 tokens | 0 tokens | 0.00% |
| Combined canonical tool + skill catalog bytes | 38,510 bytes | 33,245 bytes | -5,265 bytes | 13.67% |
| Combined tool + skill estimate | 9,619 tokens | 8,304 tokens | -1,315 tokens | 13.67% |

The 11 initially active tools were exactly `read`, `bash`, `edit`, `write`, `bg_start`, `memory_search`, `context_recall`, `fd`, `rg`, `subagent_spawn`, and `mcp`. The `workflow` tool and all nine background-terminal/subagent control tools were absent.

### Initial orchestration contribution

| Group | Baseline active | Post-change initially active | Baseline canonical | Post-change canonical | Canonical reduction | Baseline estimate | Post-change estimate | Token reduction |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Background terminals (`bg_*`) | 4 | 1 | 2,095 bytes | 1,199 bytes | 42.77% | 524 tokens | 299 tokens | 42.94% |
| Subagents (`subagent_*`) | 7 | 1 | 4,212 bytes | 2,484 bytes | 41.03% | 1,056 tokens | 621 tokens | 41.19% |
| Workflow | 1 | 0 | 3,871 bytes | 0 bytes | 100.00% | 963 tokens | 0 tokens | 100.00% |
| All orchestration tools | 12 | 2 | 10,178 bytes | 3,683 bytes | 63.81% | 2,543 tokens | 920 tokens | 63.82% |
| Deferred candidates beyond `bg_start` / `subagent_spawn` (overlapping subtotal) | 10 | 0 | 6,888 bytes | 0 bytes | 100.00% | 1,721 tokens | 0 tokens | 100.00% |

### Offline activation validation

A second ephemeral offline measurement reused the same canonical serialization and skill formatting. To avoid executing `subagent_spawn` and therefore making a provider request, its temporary measurement command imported the production activation predicate/helpers directly. It passed the literal explicit trigger `ultracode` to `shouldActivateWorkflow()`, then called `activateWorkflowTool()`, `activateBgTools()`, and `activateSubagentTools()`. This tests the current production selection logic without editing an extension or executing an orchestration tool.

The no-trigger measurement above had no `workflow`. In the second measurement, `shouldActivateWorkflow("ultracode")` returned `true`, `workflow` was added, and both control activators returned `true`. Activation was additive: all 11 initial names remained selected, then `workflow` and exactly these nine controls were added: `bg_status`, `bg_list`, `bg_kill`, `subagent_wait`, `subagent_send`, `subagent_inbox`, `subagent_cancel`, `subagent_check`, and `subagent_list`.

| Offline measurement state | Registered tools | Active tools | Canonical tool payload | Tool estimate | Skill catalog | Skill estimate | Combined bytes | Combined estimate |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Initial, no explicit workflow trigger | 24 | 11 | 12,880 bytes | 3,217 tokens | 20,365 bytes | 5,087 tokens | 33,245 bytes | 8,304 tokens |
| Explicit workflow trigger + both control groups | 24 | 21 | 19,768 bytes | 4,938 tokens | 20,365 bytes | 5,087 tokens | 40,133 bytes | 10,025 tokens |
| Additive activation delta | 0 | +10 | +6,888 bytes | +1,721 tokens | 0 bytes | 0 tokens | +6,888 bytes | +1,721 tokens |

| Activated addition | Tools added | Canonical bytes added | Estimated tokens added |
|---|---:|---:|---:|
| Workflow after explicit trigger | 1 | 3,871 | 963 |
| Background-terminal controls | 3 | 896 | 225 |
| Subagent controls | 6 | 2,121 | 533 |
| Total | 10 | 6,888 | 1,721 |

The initial/no-trigger state is the relevant **first-request fixed schema/catalog saving**: 5,265 fewer combined canonical tool-plus-skill-catalog bytes and 1,315 fewer estimated tokens than the baseline, a 13.67% reduction in either combined total. The activation measurement shows that the deferred 6,888 bytes / 1,721 estimated tokens return only after explicit workflow activation and control activation; it is not an additional permanent saving.

The targeted offline activation/session regression suite also passed 10/10 tests (`background-terminals/tool-activation.test.ts`, `subagents/tool-activation.test.ts`, and `workflows/activation.test.mts`). It covered deferred startup, additive activation, branch restoration, and extension-instance reset/restore behavior. The production workflow predicate additionally returned `false` for the measurement request and negated workflow language, and `true` for `ultracode` and an explicit workflow-run request.

These are offline schema/catalog measurements only. Because no provider call was made, this run did **not** measure provider tokenizer counts, request-wrapper bytes, reported prompt/input tokens, cache reads or writes, cache-hit rate, cached-token billing, or latency. The percentages above must not be interpreted as provider-cache savings or cache-performance metrics.
