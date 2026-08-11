/**
 * End-to-end smoke tests: manager behavior through a real ManagedRuntime,
 * exactly as the tool handlers drive it. The registry uses a scripted Pi
 * backend by default; the production Pi backend covers its cheap precondition.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { Effect, Layer, ManagedRuntime, Stream } from "effect";
import {
  BackendRegistry,
  type BackendSpawnTask,
  type SubagentBackend,
} from "./src/backend.ts";
import { piBackend } from "./src/backends/pi.ts";
import { makeStubBackend } from "./src/backends/stub.ts";
import type {
  BackendName,
  ParentContext,
  SpawnTask,
  SubagentEvent,
} from "./src/domain.ts";
import {
  SubagentManager,
  SubagentManagerLive,
  type SubagentManagerShape,
} from "./src/manager.ts";
import { runTool } from "./src/runtime.ts";

const piStub = makeStubBackend({
  backend: "pi",
  defaultModelLabel: "pi/test",
  contextWindow: 272_000,
  toolName: "bash",
  cadenceMs: 30,
});

const messagingPiStub: SubagentBackend = {
  ...piStub,
  spawn: (task: BackendSpawnTask) => {
    if (task.prompt.startsWith("MESSAGE:")) {
      task.messaging.sendToParent(task.prompt.slice("MESSAGE:".length), "pm-7");
    }
    return piStub.spawn(task);
  },
};

const createTestRuntime = (backend: SubagentBackend = messagingPiStub) => {
  const registry = Layer.sync(
    BackendRegistry,
    () => new Map<BackendName, SubagentBackend>([["pi", backend]]),
  );
  return ManagedRuntime.make(SubagentManagerLive.pipe(Layer.provide(registry)));
};

const parent: ParentContext = {
  parentCwd: process.cwd(),
  projectTrusted: false,
};

function task(prompt: string): SpawnTask {
  return { prompt, title: "test", cwd: process.cwd(), parent };
}

async function withManager(
  run: (
    manager: SubagentManagerShape,
    runtime: ReturnType<typeof createTestRuntime>,
  ) => Promise<void>,
  backend: SubagentBackend = messagingPiStub,
) {
  const runtime = createTestRuntime(backend);
  try {
    const manager = await runtime.runPromise(SubagentManager);
    await run(manager, runtime);
  } finally {
    await runtime.dispose();
  }
}

test("successful waits leave settlement deliverable until the tool claims its run", async () => {
  await withManager(async (manager, runtime) => {
    const settled: Array<{ id: string; consumed: boolean }> = [];
    manager.view.setOnSettled((snap, consumed) =>
      settled.push({ id: snap.id, consumed }),
    );

    const snap = await runTool(
      runtime,
      manager.spawn("pi", task("Say hello to the tests")),
    );
    assert.equal(snap.status, "running");
    assert.equal(snap.backend, "pi");
    assert.ok(snap.meta.sessionFilePath);

    const [waited] = await runTool(runtime, manager.waitFor([snap]));
    const done = manager.view.get(snap.id);
    assert.ok(done);
    assert.equal(done.status, "done");
    assert.match(
      done.finalText,
      /\[stub:pi\] completed: Say hello to the tests/,
    );
    assert.ok(done.turns >= 2);
    assert.ok(done.transcript.some((item) => item.kind === "toolResult"));
    assert.equal(waited?.id, snap.id);
    assert.equal(waited?.runSequence, 1);
    assert.equal(waited?.status, "done");
    assert.match(waited?.finalText ?? "", /Say hello to the tests/);
    assert.equal(Object.isFrozen(waited), true);
    // The interruptible manager barrier does not consume before tool return.
    assert.deepEqual(settled, [{ id: snap.id, consumed: false }]);
  });
});

test("interrupting a wait releases retention without consuming settlement", async () => {
  await withManager(async (manager, runtime) => {
    const settled: Array<{ id: string; consumed: boolean }> = [];
    manager.view.setOnSettled((snap, consumed) =>
      settled.push({ id: snap.id, consumed }),
    );
    const snap = await runTool(
      runtime,
      manager.spawn("pi", task("Finish after the wait is interrupted")),
    );
    let markWaiting!: () => void;
    const waitStarted = new Promise<void>((resolve) => {
      markWaiting = resolve;
    });
    const controller = new AbortController();
    const waiting = runTool(runtime, manager.waitFor([snap], markWaiting), {
      signal: controller.signal,
      interruptMessage: "Wait aborted",
    });
    await waitStarted;
    controller.abort();

    await assert.rejects(waiting, /Wait aborted/);
    const [settledRun] = await runTool(runtime, manager.waitFor([snap]));

    assert.equal(settledRun?.id, snap.id);
    assert.equal(settledRun?.runSequence, 1);
    assert.deepEqual(settled, [{ id: snap.id, consumed: false }]);
  });
});

test("FAIL: prompts settle as errors; unconsumed settles are delivered", async () => {
  await withManager(async (manager, runtime) => {
    const settled: Array<{ id: string; consumed: boolean }> = [];
    manager.view.setOnSettled((snap, consumed) =>
      settled.push({ id: snap.id, consumed }),
    );

    const snap = await runTool(
      runtime,
      manager.spawn("pi", task("FAIL: blow up please")),
    );
    // Poll without wait-interest so the settle is delivered unconsumed.
    while (manager.view.get(snap.id)?.status === "running") {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const failed = manager.view.get(snap.id);
    assert.equal(failed?.status, "error");
    assert.match(failed?.errorText ?? "", /task failed/);
    assert.deepEqual(settled, [{ id: snap.id, consumed: false }]);
  });
});

test("cancel interrupts a running stub subagent", async () => {
  await withManager(async (manager, runtime) => {
    const settled: Array<{ id: string; consumed: boolean }> = [];
    manager.view.setOnSettled((settledSnap, consumed) =>
      settled.push({ id: settledSnap.id, consumed }),
    );
    const snap = await runTool(
      runtime,
      manager.spawn("pi", task("Long running task")),
    );
    const report = await runTool(runtime, manager.cancel([snap]));
    assert.deepEqual(report, [
      {
        id: snap.id,
        runSequence: 1,
        title: "test",
        status: "error",
        cancelled: true,
      },
    ]);
    assert.equal(manager.view.get(snap.id)?.errorText, "Run was aborted");
    // Manager cancellation does not consume before the interruptible tool
    // boundary succeeds and claims this exact run.
    assert.deepEqual(settled, [{ id: snap.id, consumed: false }]);
  });
});

test("concurrent waits both remain barriers for the same exact run", async () => {
  await withManager(async (manager, runtime) => {
    const snap = await runTool(
      runtime,
      manager.spawn("pi", task("shared wait barrier")),
    );
    let firstSettled = false;
    let secondSettled = false;
    const firstWait = runTool(runtime, manager.waitFor([snap])).then((runs) => {
      firstSettled = true;
      return runs;
    });
    const secondWait = runTool(runtime, manager.waitFor([snap])).then(
      (runs) => {
        secondSettled = true;
        return runs;
      },
    );

    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(firstSettled, false);
    assert.equal(secondSettled, false);

    const [firstResult, secondResult] = await Promise.all([
      firstWait,
      secondWait,
    ]);
    assert.equal(firstResult[0]?.runSequence, 1);
    assert.equal(secondResult[0]?.runSequence, 1);
  });
});

test("cancel still acts while a wait retains the exact run", async () => {
  await withManager(async (manager, runtime) => {
    const snap = await runTool(
      runtime,
      manager.spawn("pi", task("cancel through wait ownership")),
    );
    const waiting = runTool(runtime, manager.waitFor([snap]));

    const [cancelled] = await runTool(runtime, manager.cancel([snap]));
    const [waited] = await waiting;

    assert.equal(cancelled?.cancelled, true);
    assert.equal(cancelled?.runSequence, 1);
    assert.equal(waited?.runSequence, 1);
    assert.equal(waited?.status, "error");
  });
});

test("spawn origin propagates to ids, snapshots, and settlement", async () => {
  await withManager(async (manager, runtime) => {
    const settled: Array<{ id: string; origin: string }> = [];
    manager.view.setOnSettled((snap) =>
      settled.push({ id: snap.id, origin: snap.origin }),
    );

    const model = await runTool(
      runtime,
      manager.spawn("pi", task("model task")),
    );
    const btw = await runTool(
      runtime,
      manager.spawn("pi", { ...task("side question"), origin: "btw" }),
    );

    assert.match(model.id, /^sa-/);
    assert.equal(model.origin, "model");
    assert.match(btw.id, /^btw-/);
    assert.equal(btw.origin, "btw");

    await runTool(runtime, manager.cancel([model, btw]));
    assert.deepEqual(
      settled.sort((a, b) => a.id.localeCompare(b.id)),
      [
        { id: btw.id, origin: "btw" },
        { id: model.id, origin: "model" },
      ].sort((a, b) => a.id.localeCompare(b.id)),
    );
  });
});

test("the global concurrency cap includes by-the-way sessions", async () => {
  await withManager(async (manager, runtime) => {
    const tasks: SpawnTask[] = [
      { ...task("side question"), origin: "btw" },
      task("Task 2"),
      task("Task 3"),
      task("Task 4"),
    ];
    const spawns = await runTool(
      runtime,
      Effect.forEach(tasks, (spawnTask) => manager.spawn("pi", spawnTask), {
        concurrency: "unbounded",
      }),
    );
    assert.equal(spawns.length, 4);
    await assert.rejects(
      runTool(
        runtime,
        manager.spawn("pi", {
          ...task("another side question"),
          origin: "btw",
        }),
      ),
      /Max 4 subagents/,
    );
  });
});

test("the concurrency cap rejects a fifth running subagent", async () => {
  await withManager(async (manager, runtime) => {
    const spawns = await runTool(
      runtime,
      Effect.forEach(
        [1, 2, 3, 4],
        (n) => manager.spawn("pi", task(`Task ${n}`)),
        { concurrency: "unbounded" },
      ),
    );
    assert.equal(spawns.length, 4);
    await assert.rejects(
      runTool(runtime, manager.spawn("pi", task("Task 5"))),
      /Max 4 subagents/,
    );
  });
});

test("pi spawn fails fast without the parent model registry", async () => {
  await withManager(async (manager, runtime) => {
    await assert.rejects(
      runTool(runtime, manager.spawn("pi", task("needs a registry"))),
      /model registry/,
    );
  }, piBackend);
});

test("live-delivered child messages are not duplicated in the inbox", async () => {
  await withManager(async (manager, runtime) => {
    const delivered: Array<{
      id: string;
      subagentId: string;
      message: string;
    }> = [];
    manager.view.setOnMessage((message) => {
      delivered.push({
        id: message.id,
        subagentId: message.subagentId,
        message: message.message,
      });
      return true;
    });

    const snap = await runTool(
      runtime,
      manager.spawn("pi", task("MESSAGE:Need the expected format")),
    );
    assert.deepEqual(delivered, [
      {
        id: "cm-1",
        subagentId: snap.id,
        message: "Need the expected format",
      },
    ]);

    assert.deepEqual(await runTool(runtime, manager.inbox), []);
  });
});

test("child messages remain in the inbox when live delivery fails", async () => {
  await withManager(async (manager, runtime) => {
    manager.view.setOnMessage(() => {
      throw new Error("parent session unavailable");
    });

    await runTool(
      runtime,
      manager.spawn("pi", task("MESSAGE:Recover this message")),
    );

    const inbox = await runTool(runtime, manager.inbox);
    assert.equal(inbox.length, 1);
    assert.equal(inbox[0]?.message, "Recover this message");
    assert.deepEqual(await runTool(runtime, manager.inbox), []);
  });
});

test("orchestrator messages only steer running children", async () => {
  await withManager(async (manager, runtime) => {
    const snap = await runTool(
      runtime,
      manager.spawn("pi", task("Long running task")),
    );
    const messageId = await runTool(
      runtime,
      manager.message(snap.id, "Check the parser too", "cm-2"),
    );
    assert.equal(messageId, "pm-1");

    await runTool(runtime, manager.cancel([snap]));
    await assert.rejects(
      runTool(runtime, manager.message(snap.id, "One more thing")),
      /only be sent while it is running/,
    );
  });
});

test("idle restarts respect the concurrency cap", async () => {
  await withManager(async (manager, runtime) => {
    // Settle one subagent, then fill all four slots with running ones.
    const settled = await runTool(
      runtime,
      manager.spawn("pi", task("early finisher")),
    );
    await runTool(runtime, manager.waitFor([settled]));
    await runTool(
      runtime,
      Effect.forEach(
        [1, 2, 3, 4],
        (n) => manager.spawn("pi", task(`Task ${n}`)),
        { concurrency: "unbounded" },
      ),
    );
    // Restarting the settled one would be a fifth concurrent run.
    await assert.rejects(
      runTool(runtime, manager.send(settled.id, "go again")),
      /Max 4 subagents/,
    );
    assert.equal(manager.view.get(settled.id)?.status, "done");
  });
});

test("send steers an idle subagent into another turn", async () => {
  await withManager(async (manager, runtime) => {
    const snap = await runTool(
      runtime,
      manager.spawn("pi", task("First turn")),
    );
    await runTool(runtime, manager.waitFor([snap]));
    const afterFirst = manager.view.get(snap.id);
    assert.equal(afterFirst?.status, "done");
    assert.equal(afterFirst?.runSequence, 1);

    await runTool(runtime, manager.send(snap.id, "Second turn"));
    // The fresh run flips the status back to running...
    while (manager.view.get(snap.id)?.status !== "running") {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await runTool(runtime, manager.waitFor([{ id: snap.id, runSequence: 2 }]));
    const afterSecond = manager.view.get(snap.id);
    assert.equal(afterSecond?.status, "done");
    assert.equal(afterSecond?.runSequence, 2);
    assert.match(afterSecond?.finalText ?? "", /Second turn/);
  });
});

test("a waited settled snapshot stays exact across an immediate restart", async () => {
  await withManager(async (manager, runtime) => {
    const spawned = await runTool(
      runtime,
      manager.spawn("pi", task("first immutable run")),
    );
    const [firstRun] = await runTool(runtime, manager.waitFor([spawned]));
    assert.ok(firstRun);

    await runTool(runtime, manager.send(spawned.id, "second mutable run"));
    const [secondRun] = await runTool(
      runtime,
      manager.waitFor([{ id: spawned.id, runSequence: 2 }]),
    );

    assert.equal(firstRun.runSequence, 1);
    assert.equal(firstRun.status, "done");
    assert.match(firstRun.finalText, /first immutable run/);
    assert.doesNotMatch(firstRun.finalText, /second mutable run/);
    assert.equal(secondRun?.runSequence, 2);
    assert.match(secondRun?.finalText ?? "", /second mutable run/);
  });
});

test("cancelling a stale run identity never aborts its replacement", async () => {
  await withManager(async (manager, runtime) => {
    const first = await runTool(
      runtime,
      manager.spawn("pi", task("first run before stale cancel")),
    );
    const staleRun = { id: first.id, runSequence: first.runSequence };
    await runTool(runtime, manager.waitFor([first]));
    await runTool(runtime, manager.send(first.id, "replacement run"));
    while (manager.view.get(first.id)?.runSequence !== 2) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    const [report] = await runTool(runtime, manager.cancel([staleRun]));

    assert.equal(report?.id, first.id);
    assert.equal(report?.runSequence, 1);
    assert.equal(report?.cancelled, false);
    assert.equal(manager.view.get(first.id)?.runSequence, 2);
    assert.equal(manager.view.get(first.id)?.status, "running");

    const replacement = manager.view.get(first.id);
    assert.ok(replacement);
    await runTool(runtime, manager.cancel([replacement]));
  });
});

test("an acknowledged exact-run interrupt blocks restart until settlement is folded", async () => {
  let markInterruptAcknowledged = () => {};
  const interruptAcknowledged = new Promise<void>((resolve) => {
    markInterruptAcknowledged = resolve;
  });
  let releaseSettlementEvent = () => {};
  const settlementEventRelease = new Promise<void>((resolve) => {
    releaseSettlementEvent = resolve;
  });
  const backend: SubagentBackend = {
    ...messagingPiStub,
    spawn: (spawnTask) =>
      messagingPiStub.spawn(spawnTask).pipe(
        Effect.map((session) => ({
          ...session,
          events: session.events.pipe(
            Stream.mapEffect((event): Effect.Effect<SubagentEvent> =>
              event._tag === "RunSettled"
                ? Effect.promise(() => settlementEventRelease).pipe(
                    Effect.as(event),
                  )
                : Effect.succeed(event),
            ),
          ),
          interrupt: session.interrupt.pipe(
            Effect.tap(() => Effect.sync(markInterruptAcknowledged)),
          ),
        })),
      ),
  };

  await withManager(async (manager, runtime) => {
    const first = await runTool(
      runtime,
      manager.spawn("pi", task("settle while interrupt is pending")),
    );
    const cancellation = runTool(runtime, manager.cancel([first]));
    await interruptAcknowledged;
    assert.equal(manager.view.get(first.id)?.status, "running");
    try {
      await assert.rejects(
        runTool(runtime, manager.send(first.id, "replacement must wait")),
        /being cancelled/,
      );
      await assert.rejects(
        runTool(
          runtime,
          manager.message(first.id, "public subagent_send must wait"),
        ),
        /being cancelled/,
      );
    } finally {
      releaseSettlementEvent();
    }
    await cancellation;

    await runTool(runtime, manager.send(first.id, "safe replacement"));
    while (manager.view.get(first.id)?.runSequence !== 2) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const replacement = manager.view.get(first.id);
    assert.equal(replacement?.status, "running");
    assert.ok(replacement);
    await runTool(runtime, manager.cancel([replacement]));
  }, backend);
});
