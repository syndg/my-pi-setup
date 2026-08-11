/**
 * SubagentManager — owns the registry of running/finished subagents.
 *
 * Each subagent is a scoped `SubagentSession` from a `SubagentBackend` plus a
 * pump fiber that folds its normalized event stream into a mutable
 * `SubagentSnapshot`. Closing a subagent's scope kills the underlying
 * session/process and stops the pump.
 *
 * The manager also exposes a synchronous `SubagentReadModel` so the
 * imperative TUI components (which render synchronously) can read snapshots
 * and issue fire-and-forget commands without touching the Effect runtime.
 */

import {
  Context,
  Effect,
  Exit,
  Fiber,
  Layer,
  Result,
  Scope,
  Stream,
} from "effect";
import type { SubagentBackend, SubagentSession } from "./backend.ts";
import { BackendRegistry } from "./backend.ts";
import type {
  BackendName,
  LiveToolState,
  RunOutcome,
  SpawnTask,
  SubagentEvent,
  SubagentOrigin,
  SubagentMeta,
  SubagentSnapshot,
  SubagentRunIdentity,
  SubagentStatus,
  TranscriptItem,
} from "./domain.ts";
import {
  BackendUnavailableError,
  ConcurrencyLimitError,
  SendError,
  SpawnError,
} from "./domain.ts";
import { ParentChildMailbox, type ChildToParentMessage } from "./messaging.ts";

export const MAX_RUNNING = 4;
export const MAX_TRACKED = 64;
const STOP_TIMEOUT_MS = 5_000;
const ERROR_TEXT_MAX_LENGTH = 4_096;
const TRANSCRIPT_TEXT_MAX_LENGTH = 64 * 1_024;
const LIVE_ASSISTANT_MAX_LENGTH = 128 * 1_024;
const FINAL_TEXT_MAX_LENGTH = 1_024 * 1_024;
const MAX_TRANSCRIPT_ITEMS = 512;

function bounded(text: string) {
  return text.slice(0, ERROR_TEXT_MAX_LENGTH);
}

function runKey(run: SubagentRunIdentity) {
  return `${run.id}:run-${run.runSequence}`;
}

function immutableSnapshot(snapshot: MutableSnapshot) {
  const cloned = structuredClone(snapshot);
  const freeze = (value: unknown) => {
    if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
      return;
    }
    for (const property of Reflect.ownKeys(value)) {
      freeze(Reflect.get(value, property));
    }
    Object.freeze(value);
  };
  freeze(cloned);
  return cloned;
}

function boundedTranscriptText(text: string) {
  return text.slice(0, TRANSCRIPT_TEXT_MAX_LENGTH);
}

function appendTranscript(snapshot: MutableSnapshot, item: TranscriptItem) {
  snapshot.transcript.push(item);
  if (snapshot.transcript.length > MAX_TRANSCRIPT_ITEMS) {
    snapshot.transcript.splice(
      0,
      snapshot.transcript.length - MAX_TRANSCRIPT_ITEMS,
    );
  }
}

// --- Internal state -----------------------------------------------------------

/** Mutable snapshot; exposed to readers via the readonly SubagentSnapshot type. */
interface MutableSnapshot {
  id: string;
  runSequence: number;
  origin: SubagentOrigin;
  backend: BackendName;
  title: string;
  prompt: string;
  cwd: string;
  toolProfile?: SpawnTask["toolProfile"];
  reportBudgetBytes?: number;
  status: SubagentStatus;
  createdAt: number;
  settledAt?: number;
  errorText?: string;
  meta: SubagentMeta;
  usage: { tokens?: number; contextWindow?: number };
  transcript: TranscriptItem[];
  liveAssistant?: { text: string; thinking: string };
  liveTools: LiveToolState[];
  queued: SubagentSnapshot["queued"];
  finalText: string;
  turns: number;
}

interface Entry {
  snapshot: MutableSnapshot;
  session: SubagentSession;
  scope: Scope.Closeable;
  pump?: Fiber.Fiber<void>;
  liveToolMap: Map<string, LiveToolState>;
  /** Idle restart dispatched but RunStarted not folded yet; counts as running
   * so concurrent restarts cannot race past the cap. */
  restarting?: boolean;
  /** Exact run currently being interrupted; blocks replacement sends. */
  interruptingRunSequence?: number;
}

// --- Read model ----------------------------------------------------------------

/** Synchronous bridge for the TUI. Snapshots are live objects; do not mutate. */
export interface SubagentReadModel {
  list(): ReadonlyArray<SubagentSnapshot>;
  get(id: string): SubagentSnapshot | undefined;
  size(): number;
  /** Any-change notification (footer status, dashboard). */
  subscribe(listener: () => void): () => void;
  /** Per-subagent notification (takeover view). */
  subscribeTo(id: string, listener: () => void): () => void;
  /** Fire-and-forget: steer/continue a subagent (takeover input). */
  requestSend(id: string, text: string): void;
  /** Fire-and-forget: abort a running subagent (dashboard `x`, takeover). */
  requestAbort(id: string): void;
  /**
   * Register the settle hook. `consumed` is retained for adapter compatibility;
   * manager settlements are emitted unconsumed so keyed tool ownership can
   * transfer only after an interruptible boundary succeeds.
   */
  setOnSettled(
    hook: ((snap: SubagentSnapshot, consumed: boolean) => void) | undefined,
  ): void;
  /**
   * Register live delivery of child-to-parent messages. Return true only when
   * the parent session accepted the message; acknowledged messages leave the
   * recovery inbox.
   */
  setOnMessage(
    hook: ((message: ChildToParentMessage) => boolean) | undefined,
  ): void;
}

// --- Service --------------------------------------------------------------------

export interface CancelResult extends SubagentRunIdentity {
  readonly title: string;
  readonly status: SubagentStatus;
  readonly cancelled: boolean;
}

export interface SubagentManagerShape {
  spawn(
    backend: BackendName,
    task: SpawnTask,
  ): Effect.Effect<
    SubagentSnapshot,
    SpawnError | ConcurrencyLimitError | BackendUnavailableError
  >;
  /**
   * Wait until all exact runs are settled. The returned snapshots are detached
   * and deeply frozen, so a restart cannot change tool output after the barrier.
   * Interruption releases retention interest and leaves results deliverable.
   */
  waitFor(
    runs: ReadonlyArray<SubagentRunIdentity>,
    onPending?: (pending: string[]) => void,
  ): Effect.Effect<ReadonlyArray<SubagentSnapshot>>;
  /** Cancel exact running runs; sequence mismatches are reported, never aborted. */
  cancel(
    runs: ReadonlyArray<SubagentRunIdentity>,
  ): Effect.Effect<ReadonlyArray<CancelResult>>;
  send(id: string, text: string): Effect.Effect<void, SendError>;
  message(
    id: string,
    text: string,
    replyTo?: string,
  ): Effect.Effect<string, SendError>;
  readonly inbox: Effect.Effect<ReadonlyArray<ChildToParentMessage>>;
  get(id: string): Effect.Effect<SubagentSnapshot | undefined>;
  readonly list: Effect.Effect<ReadonlyArray<SubagentSnapshot>>;
  readonly disposeAll: Effect.Effect<void>;
  readonly view: SubagentReadModel;
}

export class SubagentManager extends Context.Service<
  SubagentManager,
  SubagentManagerShape
>()("subagents/SubagentManager") {}

// --- Implementation --------------------------------------------------------------

const makeManager = Effect.gen(function* () {
  const registry = yield* BackendRegistry;
  // Detached forker for sync contexts (read-model commands, pruning) that
  // preserves the manager's services instead of using the global runtime.
  const runDetached = Effect.runForkWith(yield* Effect.context());

  const entries = new Map<string, Entry>();
  const settledRuns = new Map<string, SubagentSnapshot>();
  const mailbox = new ParentChildMailbox();
  const waitInterest = new Map<string, number>();
  const listeners = new Set<() => void>();
  /** One-shot nextChange waiters, swapped out before invocation so waiters
   * re-registering during notification are not visited in the same sweep. */
  let changeWaiters: Array<() => void> = [];
  const idListeners = new Map<string, Set<() => void>>();
  const cleanups = new Set<Fiber.Fiber<unknown>>();
  let modelCounter = 0;
  let btwCounter = 0;
  let reserved = 0;
  let disposed = false;
  let onSettled:
    ((snap: SubagentSnapshot, consumed: boolean) => void) | undefined;
  let onMessage: ((message: ChildToParentMessage) => boolean) | undefined;

  const notify = (id?: string) => {
    const waiters = changeWaiters;
    changeWaiters = [];
    for (const waiter of waiters) waiter();
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch {
        // A failed status/render listener must not corrupt lifecycle state.
      }
    }
    if (id) {
      for (const listener of idListeners.get(id) ?? []) {
        try {
          listener();
        } catch {
          // Same.
        }
      }
    }
  };

  /** Resolves on the next state change. Interruption unregisters the waiter. */
  const nextChange = Effect.callback<void>((resume) => {
    const waiter = () => resume(Effect.void);
    changeWaiters.push(waiter);
    return Effect.sync(() => {
      const index = changeWaiters.indexOf(waiter);
      if (index >= 0) changeWaiters.splice(index, 1);
    });
  });

  const runningCount = () =>
    [...entries.values()].filter(
      (e) => e.snapshot.status === "running" || e.restarting === true,
    ).length;

  const addInterest = (ids: ReadonlyArray<string>) => {
    for (const id of ids) waitInterest.set(id, (waitInterest.get(id) ?? 0) + 1);
  };
  const releaseInterest = (ids: ReadonlyArray<string>) => {
    for (const id of ids) {
      const count = (waitInterest.get(id) ?? 1) - 1;
      if (count <= 0) waitInterest.delete(id);
      else waitInterest.set(id, count);
    }
  };

  const closeEntryScope = (entry: Entry) =>
    Scope.close(entry.scope, Exit.void).pipe(Effect.ignore);

  const pruneSettled = () => {
    if (entries.size <= MAX_TRACKED) return;
    const candidates = [...entries.values()]
      .filter(
        (e) =>
          e.snapshot.status !== "running" && !waitInterest.has(e.snapshot.id),
      )
      .sort(
        (a, b) =>
          (a.snapshot.settledAt ?? a.snapshot.createdAt) -
          (b.snapshot.settledAt ?? b.snapshot.createdAt),
      );
    for (const entry of candidates) {
      if (entries.size <= MAX_TRACKED) break;
      entries.delete(entry.snapshot.id);
      const fiber = runDetached(closeEntryScope(entry));
      cleanups.add(fiber);
      for (const key of settledRuns.keys()) {
        if (key.startsWith(`${entry.snapshot.id}:run-`)) {
          settledRuns.delete(key);
        }
      }
      fiber.addObserver(() => cleanups.delete(fiber));
    }
  };

  const settle = (entry: Entry, outcome: RunOutcome) => {
    const s = entry.snapshot;
    entry.restarting = false;
    if (s.status !== "running") return;
    s.settledAt = Date.now();
    switch (outcome._tag) {
      case "Completed":
        s.status = "done";
        s.errorText = undefined;
        s.finalText = outcome.finalText.slice(0, FINAL_TEXT_MAX_LENGTH);
        break;
      case "Failed":
        s.status = "error";
        s.errorText = bounded(outcome.errorText);
        // Never let a failed run report the previous run's successful output.
        s.finalText = (outcome.partialText ?? "").slice(
          0,
          FINAL_TEXT_MAX_LENGTH,
        );
        break;
      case "Interrupted":
        s.status = "error";
        s.errorText = "Run was aborted";
        s.finalText = (outcome.partialText ?? "").slice(
          0,
          FINAL_TEXT_MAX_LENGTH,
        );
        break;
    }
    s.liveAssistant = undefined;
    entry.liveToolMap.clear();
    s.liveTools = [];
    s.queued = [];
    const settled = immutableSnapshot(s);
    settledRuns.set(runKey(settled), settled);
    notify(s.id);
    try {
      // During teardown, don't queue results into a shutting-down session.
      if (!disposed) onSettled?.(settled, false);
    } catch {
      // The parent session may be unavailable; settlement stays final.
    }
    pruneSettled();
  };

  const foldEvent = (entry: Entry, event: SubagentEvent) => {
    const s = entry.snapshot;
    switch (event._tag) {
      case "RunStarted":
        if (entry.restarting || s.status !== "running") s.runSequence++;
        entry.restarting = false;
        if (!waitInterest.has(s.id)) {
          for (const key of settledRuns.keys()) {
            if (key.startsWith(`${s.id}:run-`)) settledRuns.delete(key);
          }
        }
        s.status = "running";
        s.settledAt = undefined;
        s.errorText = undefined;
        break;
      case "RunSettled":
        settle(entry, event.outcome);
        return; // settle() already notified
      case "UserMessage":
        appendTranscript(s, {
          kind: "user",
          text: boundedTranscriptText(event.text),
        });
        break;
      case "AssistantDelta": {
        const live = s.liveAssistant ?? { text: "", thinking: "" };
        s.liveAssistant =
          event.kind === "text"
            ? {
                ...live,
                text: (live.text + event.delta).slice(
                  -LIVE_ASSISTANT_MAX_LENGTH,
                ),
              }
            : {
                ...live,
                thinking: (live.thinking + event.delta).slice(
                  -LIVE_ASSISTANT_MAX_LENGTH,
                ),
              };
        break;
      }
      case "AssistantMessage":
        appendTranscript(s, {
          kind: "assistant",
          parts: event.parts.map((part) =>
            part.type === "toolCall"
              ? {
                  ...part,
                  argsPreview: part.argsPreview
                    ? boundedTranscriptText(part.argsPreview)
                    : undefined,
                }
              : { ...part, text: boundedTranscriptText(part.text) },
          ),
        });
        s.liveAssistant = undefined;
        s.turns++;
        break;
      case "ToolStart":
        entry.liveToolMap.set(event.toolId, {
          toolId: event.toolId,
          name: event.name,
          argsPreview: event.argsPreview
            ? boundedTranscriptText(event.argsPreview)
            : undefined,
        });
        s.liveTools = [...entry.liveToolMap.values()];
        break;
      case "ToolUpdate": {
        const current = entry.liveToolMap.get(event.toolId);
        if (current) {
          entry.liveToolMap.set(event.toolId, {
            ...current,
            outputPreview: event.outputPreview
              ? boundedTranscriptText(event.outputPreview)
              : current.outputPreview,
          });
          s.liveTools = [...entry.liveToolMap.values()];
        }
        break;
      }
      case "ToolEnd":
        entry.liveToolMap.delete(event.toolId);
        s.liveTools = [...entry.liveToolMap.values()];
        appendTranscript(s, {
          kind: "toolResult",
          toolId: event.toolId,
          name: event.name,
          isError: event.isError,
          outputPreview: event.outputPreview
            ? boundedTranscriptText(event.outputPreview)
            : undefined,
        });
        break;
      case "QueueChanged":
        s.queued = event.queued;
        break;
      case "UsageChanged":
        s.usage = {
          tokens: event.tokens ?? s.usage.tokens,
          contextWindow: event.contextWindow ?? s.usage.contextWindow,
        };
        break;
      case "MetaChanged":
        s.meta = { ...s.meta, ...event.meta };
        break;
      case "BackendError":
        s.errorText = bounded(event.message);
        break;
    }
    notify(s.id);
  };

  const spawn = (backendName: BackendName, task: SpawnTask) =>
    Effect.gen(function* () {
      // Reserve synchronously (before the first yield inside doSpawn) so
      // parallel tool calls cannot race past the global cap.
      yield* Effect.suspend(
        (): Effect.Effect<void, SpawnError | ConcurrencyLimitError> => {
          if (disposed) {
            return new SpawnError({
              message: "Subagent manager is shutting down.",
            });
          }
          if (runningCount() + reserved >= MAX_RUNNING) {
            return new ConcurrencyLimitError({
              message: `Max ${MAX_RUNNING} subagents can run concurrently. Wait for one to finish before spawning another.`,
            });
          }
          reserved++;
          return Effect.void;
        },
      );

      const doSpawn = Effect.gen(function* () {
        const origin = task.origin ?? "model";
        const id =
          origin === "btw" ? `btw-${++btwCounter}` : `sa-${++modelCounter}`;
        const backend: SubagentBackend | undefined = registry.get(backendName);
        if (!backend) {
          return yield* new BackendUnavailableError({
            message: `Unknown backend "${backendName}".`,
          });
        }
        const available = yield* backend.available;
        if (!available) {
          return yield* new BackendUnavailableError({
            message: `Backend "${backendName}" is not available on this machine (binary/SDK/credentials missing).`,
          });
        }

        const scope = yield* Scope.make();
        const session = yield* Scope.provide(
          backend.spawn({
            ...task,
            messaging: {
              childId: id,
              sendToParent: (text, replyTo) => {
                if (disposed) {
                  throw new Error("Parent subagent manager is shutting down.");
                }
                const received = mailbox.receiveChildMessage(
                  id,
                  task.title,
                  text,
                  replyTo,
                );
                try {
                  if (onMessage?.(received) === true) {
                    mailbox.acknowledgeChildMessage(received.id);
                  }
                } catch {
                  // The message remains available through inbox when live
                  // parent delivery is unavailable or rejects it.
                }
                return received;
              },
            },
          }),
          scope,
        ).pipe(Effect.onError(() => Scope.close(scope, Exit.void)));
        if (disposed) {
          yield* Scope.close(scope, Exit.void);
          return yield* new SpawnError({
            message: "Subagent manager shut down while spawning.",
          });
        }

        const meta = yield* session.meta;
        const entry: Entry = {
          snapshot: {
            id,
            runSequence: 1,
            origin,
            backend: backendName,
            title: task.title,
            prompt: task.prompt,
            cwd: task.cwd,
            toolProfile: task.toolProfile,
            reportBudgetBytes: task.reportBudgetBytes,
            status: "running",
            createdAt: Date.now(),
            meta,
            usage: { contextWindow: meta.contextWindow },
            transcript: [],
            liveTools: [],
            queued: [],
            finalText: "",
            turns: 0,
          },
          session,
          scope,
          liveToolMap: new Map(),
        };
        entries.set(id, entry);

        // Pump: fold the event stream into the snapshot. Tied to the entry
        // scope, so closing the scope stops it. If the stream ends while the
        // subagent still looks running, the backend died out from under us.
        const pump = Stream.runForEach(session.events, (event) =>
          Effect.sync(() => foldEvent(entry, event)),
        ).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              if (entry.snapshot.status === "running") {
                settle(entry, {
                  _tag: "Failed",
                  errorText: "Backend event stream ended unexpectedly",
                });
              }
            }),
          ),
        );
        entry.pump = yield* Scope.provide(Effect.forkScoped(pump), scope);

        notify(id);
        return entry.snapshot as SubagentSnapshot;
      });

      return yield* doSpawn.pipe(
        Effect.ensuring(
          Effect.sync(() => {
            reserved--;
            notify();
          }),
        ),
      );
    });

  const waitFor = (
    runs: ReadonlyArray<SubagentRunIdentity>,
    onPending?: (pending: string[]) => void,
  ) =>
    Effect.suspend(() => {
      const unique = [
        ...new Map(
          runs.map((run) => [
            runKey(run),
            { id: run.id, runSequence: run.runSequence },
          ]),
        ).values(),
      ];
      const ids = [...new Set(unique.map((run) => run.id))];
      addInterest(ids);
      const loop = Effect.gen(function* () {
        while (true) {
          const pending = unique
            .filter((run) => {
              if (settledRuns.has(runKey(run))) return false;
              const entry = entries.get(run.id);
              const current = entry?.snapshot;
              if (!current) return false;
              if (current.runSequence < run.runSequence) {
                return entry.restarting === true;
              }
              return (
                current.runSequence === run.runSequence &&
                current.status === "running"
              );
            })
            .map((run) => run.id);
          if (pending.length === 0) {
            return unique.flatMap((run) => {
              const settled = settledRuns.get(runKey(run));
              if (settled) return [settled];
              const current = entries.get(run.id)?.snapshot;
              return current?.runSequence === run.runSequence &&
                current.status !== "running"
                ? [immutableSnapshot(current)]
                : [];
            });
          }
          onPending?.(pending);
          yield* nextChange;
        }
      });
      return loop.pipe(
        Effect.ensuring(
          Effect.sync(() => {
            releaseInterest(ids);
            pruneSettled();
          }),
        ),
      );
    });

  /** Interrupt one reserved exact run and wait until its settlement is folded. */
  const abortEntry = (entry: Entry, requested: SubagentRunIdentity) =>
    Effect.gen(function* () {
      if (
        entry.snapshot.status !== "running" ||
        entry.snapshot.runSequence !== requested.runSequence
      ) {
        return false;
      }
      const graceful = yield* entry.session.interrupt.pipe(
        Effect.timeout(STOP_TIMEOUT_MS),
        Effect.result,
      );
      let forceError: string | undefined;
      if (Result.isFailure(graceful)) {
        forceError = "Abort deadline exceeded; session was force-disposed";
      } else {
        const folded = yield* Effect.gen(function* () {
          while (
            entry.snapshot.status === "running" &&
            entry.snapshot.runSequence === requested.runSequence
          ) {
            yield* nextChange;
          }
        }).pipe(Effect.timeout(STOP_TIMEOUT_MS), Effect.result);
        if (Result.isFailure(folded)) {
          forceError =
            "Interrupt was acknowledged without a settlement event; session was force-disposed";
        }
      }
      if (forceError) {
        // Settle before closing the scope so the pump's stream-ended
        // fallback ("Backend event stream ended unexpectedly") cannot win
        // the race and report the wrong terminal reason.
        const shouldClose = yield* Effect.sync(() => {
          if (entry.snapshot.runSequence !== requested.runSequence) {
            return false;
          }
          settle(entry, { _tag: "Interrupted" });
          entry.snapshot.errorText = forceError;
          notify(entry.snapshot.id);
          return true;
        });
        // Bound the close like disposeAll does: a stuck backend finalizer
        // must not hang cancel after the run is already settled. Never close
        // an entry that has advanced to a replacement run.
        if (shouldClose) {
          yield* closeEntryScope(entry).pipe(
            Effect.timeout(STOP_TIMEOUT_MS),
            Effect.ignore,
          );
        }
      }
      return true;
    }).pipe(
      // Cancellation is an action, not only a wait. Once reserved, finish the
      // bounded interrupt and settlement handoff before admitting a restart.
      Effect.uninterruptible,
      Effect.ensuring(
        Effect.sync(() => {
          if (entry.interruptingRunSequence === requested.runSequence) {
            entry.interruptingRunSequence = undefined;
          }
        }),
      ),
    );

  const cancel = (runs: ReadonlyArray<SubagentRunIdentity>) =>
    Effect.suspend(() => {
      const unique = [
        ...new Map(
          runs.map((run) => [
            runKey(run),
            { id: run.id, runSequence: run.runSequence },
          ]),
        ).values(),
      ];
      const matched = unique.flatMap((run) => {
        const entry = entries.get(run.id);
        if (
          entry?.snapshot.status !== "running" ||
          entry.snapshot.runSequence !== run.runSequence ||
          entry.interruptingRunSequence !== undefined
        ) {
          return [];
        }
        // Reserve synchronously before the interrupt effect yields so send()
        // cannot restart this entry and redirect the pending interrupt.
        entry.interruptingRunSequence = run.runSequence;
        return [{ run, entry }];
      });
      const matchedIds = [...new Set(matched.map(({ run }) => run.id))];
      addInterest(matchedIds);
      const work = Effect.gen(function* () {
        const attempts = yield* Effect.forEach(
          matched,
          ({ run, entry }) => abortEntry(entry, run),
          { concurrency: "unbounded" },
        );
        while (
          matched.some(
            ({ run, entry }) =>
              entry.snapshot.runSequence === run.runSequence &&
              entry.snapshot.status === "running",
          )
        ) {
          yield* nextChange;
        }
        return new Set(
          matched
            .filter((_, index) => attempts[index] === true)
            .map(({ run }) => runKey(run)),
        );
      });
      return work.pipe(
        Effect.ensuring(
          Effect.sync(() => {
            for (const { run, entry } of matched) {
              if (entry.interruptingRunSequence === run.runSequence) {
                entry.interruptingRunSequence = undefined;
              }
            }
            releaseInterest(matchedIds);
            pruneSettled();
          }),
        ),
        Effect.map((attempted): ReadonlyArray<CancelResult> =>
          unique.map((run) => {
            const exact = settledRuns.get(runKey(run));
            const current = entries.get(run.id)?.snapshot;
            return {
              ...run,
              title: exact?.title ?? current?.title ?? "?",
              status: exact?.status ?? current?.status ?? "error",
              cancelled: attempted.has(runKey(run)),
            };
          }),
        ),
      );
    });

  const send = (id: string, text: string) =>
    Effect.suspend((): Effect.Effect<void, SendError> => {
      const entry = entries.get(id);
      if (!entry || disposed) {
        return new SendError({
          message: `Subagent "${id}" is no longer tracked.`,
        });
      }
      if (entry.interruptingRunSequence !== undefined) {
        return new SendError({
          message: `Subagent "${id}" is being cancelled; wait for cancellation to settle before sending.`,
        });
      }
      // Restarting a settled subagent occupies a running slot again, so it
      // must respect the same cap as spawn. Steering an already-running one
      // does not consume additional capacity.
      if (entry.snapshot.status !== "running") {
        if (runningCount() + reserved >= MAX_RUNNING) {
          return new SendError({
            message: `Max ${MAX_RUNNING} subagents can run concurrently; restarting "${id}" would exceed that.`,
          });
        }
        // Occupy the slot synchronously: the RunStarted that flips status
        // arrives via the async pump, and two concurrent restarts must not
        // both pass the check in that window. Cleared by RunStarted/settle,
        // or here when the backend rejects the send.
        entry.restarting = true;
        return entry.session.send(text).pipe(
          Effect.onError(() =>
            Effect.sync(() => {
              entry.restarting = false;
            }),
          ),
        );
      }
      return entry.session.send(text);
    });

  const message = (id: string, text: string, replyTo?: string) =>
    Effect.suspend((): Effect.Effect<string, SendError> => {
      const entry = entries.get(id);
      if (!entry || disposed) {
        return new SendError({
          message: `Subagent "${id}" is no longer tracked.`,
        });
      }
      if (entry.interruptingRunSequence !== undefined) {
        return new SendError({
          message: `Subagent "${id}" is being cancelled; wait for cancellation to settle before sending.`,
        });
      }
      if (entry.snapshot.status !== "running") {
        return new SendError({
          message: `Subagent "${id}" is ${entry.snapshot.status}; messages can only be sent while it is running.`,
        });
      }

      let outbound: ReturnType<ParentChildMailbox["createParentMessage"]>;
      try {
        outbound = mailbox.createParentMessage(id, text, replyTo);
      } catch (error) {
        return new SendError({
          message: error instanceof Error ? error.message : String(error),
        });
      }
      return entry.session
        .send(outbound.prompt)
        .pipe(Effect.map(() => outbound.id));
    });

  const inbox = Effect.sync(() => mailbox.drain());

  const disposeAll = Effect.gen(function* () {
    disposed = true;
    mailbox.clear();
    const all = [...entries.values()];
    entries.clear();
    settledRuns.clear();
    yield* Effect.forEach(
      all,
      (entry) =>
        closeEntryScope(entry).pipe(
          Effect.timeout(STOP_TIMEOUT_MS),
          Effect.ignore,
        ),
      { concurrency: "unbounded" },
    );
    // Pruning cleanups are detached; bound them like everything else so a
    // stuck backend finalizer cannot block runtime shutdown indefinitely.
    yield* Effect.forEach(
      [...cleanups],
      (fiber) =>
        Fiber.await(fiber).pipe(Effect.timeout(STOP_TIMEOUT_MS), Effect.ignore),
      { concurrency: "unbounded" },
    ).pipe(Effect.ignore);
    yield* Effect.sync(() => notify());
  });

  const view: SubagentReadModel = {
    list: () => [...entries.values()].map((entry) => entry.snapshot),
    get: (id) => entries.get(id)?.snapshot,
    size: () => entries.size,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    subscribeTo: (id, listener) => {
      let set = idListeners.get(id);
      if (!set) {
        set = new Set();
        idListeners.set(id, set);
      }
      set.add(listener);
      return () => {
        set.delete(listener);
        if (set.size === 0) idListeners.delete(id);
      };
    },
    requestSend: (id, text) => {
      runDetached(send(id, text).pipe(Effect.ignore));
    },
    requestAbort: (id) => {
      const entry = entries.get(id);
      if (
        !entry ||
        entry.snapshot.status !== "running" ||
        entry.interruptingRunSequence !== undefined
      ) {
        return;
      }
      // UI-initiated aborts are not "consumed": the failed result still
      // flows back to the parent as a follow-up message, matching v1.
      const requested = { id, runSequence: entry.snapshot.runSequence };
      entry.interruptingRunSequence = requested.runSequence;
      runDetached(abortEntry(entry, requested).pipe(Effect.ignore));
    },
    setOnSettled: (hook) => {
      onSettled = hook;
    },
    setOnMessage: (hook) => {
      onMessage = hook;
    },
  };

  // Safety net: disposing the ManagedRuntime tears everything down even if
  // the extension forgot to call disposeAll explicitly.
  yield* Effect.addFinalizer(() => disposeAll);

  return SubagentManager.of({
    spawn,
    waitFor,
    cancel,
    send,
    message,
    inbox,
    get: (id) => Effect.sync(() => entries.get(id)?.snapshot),
    list: Effect.sync(() => [...entries.values()].map((e) => e.snapshot)),
    disposeAll,
    view,
  });
});

export const SubagentManagerLive: Layer.Layer<
  SubagentManager,
  never,
  BackendRegistry
> = Layer.effect(SubagentManager, makeManager);
