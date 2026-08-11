import type { SubagentRunIdentity } from "./domain.ts";

export function subagentRunKey(run: SubagentRunIdentity) {
  return `${run.id}:run-${run.runSequence}`;
}

const MAX_TERMINAL_TOMBSTONES = 256;

export interface ResultToolOwner {
  readonly kind: "wait" | "cancel";
  readonly token: symbol;
}

export type ResultOwnership = "tool" | "automatic" | "other-tool" | "consumed";

interface PendingResult<T> {
  readonly state: "pending";
  readonly result: T;
}

interface ReservedResult<T> {
  readonly state: "reserved";
  readonly owner: ResultToolOwner;
  readonly result?: T;
}

interface AutomaticResult<T> {
  readonly state: "automatic";
  readonly result: T;
}

interface AutomaticCompleteResult {
  readonly state: "automatic-complete";
  readonly run: SubagentRunIdentity;
}

interface ConsumedResult {
  readonly state: "consumed";
  readonly run: SubagentRunIdentity;
}

type LifecycleResult<T> =
  | PendingResult<T>
  | ReservedResult<T>
  | AutomaticResult<T>
  | AutomaticCompleteResult
  | ConsumedResult;

export function createDeferredResultDelivery<T extends SubagentRunIdentity>() {
  const results = new Map<string, LifecycleResult<T>>();

  const observe = (run: SubagentRunIdentity) => {
    for (const [key, current] of results) {
      if (
        (current.state === "consumed" ||
          current.state === "automatic-complete") &&
        current.run.id === run.id &&
        current.run.runSequence < run.runSequence
      ) {
        results.delete(key);
      }
    }
  };

  const pruneTerminalTombstones = () => {
    let terminalCount = 0;
    for (const current of results.values()) {
      if (
        current.state === "consumed" ||
        current.state === "automatic-complete"
      ) {
        terminalCount++;
      }
    }
    if (terminalCount <= MAX_TERMINAL_TOMBSTONES) return;
    for (const [key, current] of results) {
      if (
        current.state !== "consumed" &&
        current.state !== "automatic-complete"
      )
        continue;
      results.delete(key);
      terminalCount--;
      if (terminalCount <= MAX_TERMINAL_TOMBSTONES) return;
    }
  };

  const reserve = (
    owner: ResultToolOwner,
    runs: Iterable<SubagentRunIdentity>,
  ) =>
    [...runs].map((run) => {
      observe(run);
      const key = subagentRunKey(run);
      const current = results.get(key);
      let ownership: ResultOwnership;
      if (!current || current.state === "pending") {
        results.set(key, {
          state: "reserved",
          owner,
          ...(current?.state === "pending" ? { result: current.result } : {}),
        });
        ownership = "tool";
      } else if (current.state === "automatic") {
        ownership = "automatic";
      } else if (current.state === "automatic-complete") {
        ownership = "automatic";
      } else if (current.state === "consumed") {
        ownership = "consumed";
      } else {
        ownership = current.owner === owner ? "tool" : "other-tool";
      }
      return { run, ownership };
    });

  return {
    createToolOwner(kind: ResultToolOwner["kind"]): ResultToolOwner {
      return { kind, token: Symbol(kind) };
    },
    defer(result: T) {
      observe(result);
      const key = subagentRunKey(result);
      const current = results.get(key);
      if (!current) {
        results.set(key, { state: "pending", result });
      } else if (current.state === "reserved" && !current.result) {
        results.set(key, { ...current, result });
      }
    },
    reserve,
    consume(owner: ResultToolOwner, runs: Iterable<SubagentRunIdentity>) {
      for (const run of runs) {
        const key = subagentRunKey(run);
        const current = results.get(key);
        if (current?.state === "reserved" && current.owner === owner) {
          results.set(key, { state: "consumed", run: { ...run } });
          pruneTerminalTombstones();
        }
      }
    },
    release(owner: ResultToolOwner, runs: Iterable<SubagentRunIdentity>) {
      for (const run of runs) {
        const key = subagentRunKey(run);
        const current = results.get(key);
        if (current?.state !== "reserved" || current.owner !== owner) continue;
        if (current.result) {
          results.set(key, { state: "pending", result: current.result });
        } else {
          results.delete(key);
        }
      }
    },
    beginAutomaticDelivery() {
      const deliveries: Array<{
        readonly result: T;
        readonly complete: () => void;
        readonly retry: () => void;
      }> = [];
      for (const [key, current] of results) {
        if (current.state !== "pending") continue;
        const automatic: AutomaticResult<T> = {
          state: "automatic",
          result: current.result,
        };
        results.set(key, automatic);
        deliveries.push({
          result: automatic.result,
          complete() {
            if (results.get(key) === automatic) {
              results.set(key, {
                state: "automatic-complete",
                run: automatic.result,
              });
              pruneTerminalTombstones();
            }
          },
          retry() {
            if (results.get(key) === automatic) {
              results.set(key, {
                state: "pending",
                result: automatic.result,
              });
            }
          },
        });
      }
      return deliveries;
    },
    stateSizeForTests() {
      return results.size;
    },
    clear() {
      results.clear();
    },
  };
}
