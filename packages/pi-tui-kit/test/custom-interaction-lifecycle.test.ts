import assert from "node:assert/strict";
import { setImmediate as nextInputCycle } from "node:timers/promises";
import type { ExtensionContext, KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { test } from "vitest";
import { createCustomSelectorHarness, createMockContext } from "../../../test/support.js";
import { runCustomInteraction } from "../src/custom-interaction.js";
import { createTuiHarness } from "../src/testing/tui-harness.js";
import { deferred } from "./fixtures/renderer-host.js";

for (const reason of ["Session replaced", "Session shutdown", "User cancelled"] as const) {
  test(`async custom creation is drained and disposed after ${reason}`, async () => {
    const owner = new AbortController();
    const started = deferred<void>();
    const factoryGate = deferred<void>();
    const pendingGate = deferred<void>();
    const hostClosed = deferred<void>();
    let disposed = 0;
    let taskReleased = 0;
    let lateComplete: (() => void) | undefined;
    let factorySettled = false;
    const { ctx } = createMockContext({
      mode: "tui",
      hasUI: true,
      custom: async (factory: Parameters<ExtensionContext["ui"]["custom"]>[0]) => {
        const result = deferred<unknown>();
        // Pi resolves done() before an asynchronous factory returns and discards
        // that late component instead of mounting or disposing it.
        createCustomSelectorHarness((tui: TUI, theme: Theme, keys: KeybindingsManager) => {
          void Promise.resolve(
            factory(tui, theme, keys, (value) => {
              result.resolve(value);
              hostClosed.resolve();
            }),
          ).catch(() => undefined);
          return { render: () => [], invalidate() {} };
        });
        return result.promise;
      },
    });
    const running = runCustomInteraction(ctx, {
      signal: owner.signal,
      create: async ({ signal, complete }) => {
        signal.addEventListener("abort", () => taskReleased++, { once: true });
        lateComplete = () => complete("obsolete");
        started.resolve();
        await factoryGate.promise;
        factorySettled = true;
        return {
          render: () => ["late component"],
          invalidate() {},
          dispose() {
            disposed++;
          },
          waitForPending: () => pendingGate.promise,
        };
      },
    });
    let settled = false;
    void running.then(() => {
      settled = true;
    });
    await started.promise;
    owner.abort(new DOMException(reason, "AbortError"));
    await hostClosed.promise;
    await nextInputCycle();
    const earlySettlement = settled;
    factoryGate.resolve();
    await nextInputCycle();
    const settledBeforePending = settled;
    pendingGate.resolve();
    const result = await running;
    lateComplete?.();
    assert.equal(earlySettlement, false, "runner must own the factory even after host close");
    assert.equal(settledBeforePending, false, "runner must drain returned component work");
    assert.equal(factorySettled, true);
    assert.equal(disposed, 1);
    assert.equal(taskReleased, 1);
    assert.deepEqual(result, { kind: "stale" });
  });
}

test("completion during creation disposes the component returned after done", async () => {
  const gate = deferred<void>();
  const doneCalled = deferred<void>();
  let disposed = 0;
  const harness = createTuiHarness();
  const { ctx } = createMockContext({ mode: "tui", hasUI: true, custom: harness.custom });
  const running = runCustomInteraction(ctx, {
    create: async ({ complete, signal }) => {
      const cancelledTask = deferred<void>();
      signal.addEventListener("abort", () => cancelledTask.resolve(), { once: true });
      complete("created");
      doneCalled.resolve();
      await cancelledTask.promise;
      await gate.promise;
      return { render: () => [], invalidate() {}, dispose: () => disposed++ };
    },
  });
  await doneCalled.promise;
  await nextInputCycle();
  gate.resolve();
  assert.deepEqual(await running, { kind: "completed", value: "created" });
  assert.equal(disposed, 1);
});

for (const rejection of ["signal reason", "abort-aware promise", "unrelated abort", "unrelated error"] as const) {
  test(`completion during creation preserves only its own cancellation: ${rejection}`, async () => {
    const gate = deferred<void>();
    const completed = deferred<void>();
    const failure =
      rejection === "unrelated abort" ? new DOMException("other abort", "AbortError") : new Error("failure");
    const reports: unknown[] = [];
    const harness = createTuiHarness();
    const context = createMockContext({ mode: "tui", hasUI: true, custom: harness.custom });
    const running = runCustomInteraction(context.ctx, {
      create: async ({ complete, signal }) => {
        complete("accepted");
        completed.resolve();
        await gate.promise;
        if (rejection === "signal reason") signal.throwIfAborted();
        if (rejection === "abort-aware promise") await nextInputCycle(undefined, { signal });
        throw failure;
      },
      onError: (_ctx, error) => {
        reports.push(error);
      },
    });
    let settled = false;
    void running.then(() => {
      settled = true;
    });
    await completed.promise;
    await nextInputCycle();
    const settledBeforeCreation = settled;
    gate.resolve();
    const result = await running;
    assert.equal(settledBeforeCreation, false, "completion still drains the factory");
    const expectedAbort = rejection === "signal reason" || rejection === "abort-aware promise";
    assert.deepEqual(
      result,
      expectedAbort ? { kind: "completed", value: "accepted" } : { kind: "error", error: failure },
    );
    assert.deepEqual(reports, expectedAbort ? [] : [failure]);
    assert.deepEqual(context.notifications, []);
  });
}

test("synchronous creation can complete before throwing its cancellation reason", async () => {
  const harness = createTuiHarness();
  const context = createMockContext({ mode: "tui", hasUI: true, custom: harness.custom });
  const result = await runCustomInteraction(context.ctx, {
    create: ({ complete, signal }) => {
      complete("accepted");
      signal.throwIfAborted();
      throw new Error("unreachable");
    },
  });
  assert.deepEqual(result, { kind: "completed", value: "accepted" });
  assert.deepEqual(context.notifications, []);
});

for (const transition of ["owner abort", "owner replaced"] as const) {
  test(`completion-triggered factory cancellation remains stale after ${transition}`, async () => {
    const owner = new AbortController();
    const gate = deferred<void>();
    const completed = deferred<void>();
    let current = true;
    const harness = createTuiHarness();
    const context = createMockContext({ mode: "tui", hasUI: true, custom: harness.custom });
    const running = runCustomInteraction(context.ctx, {
      signal: owner.signal,
      isCurrent: () => current,
      create: async ({ complete, signal }) => {
        complete("accepted");
        completed.resolve();
        await gate.promise;
        signal.throwIfAborted();
        throw new Error("unreachable");
      },
    });
    await completed.promise;
    if (transition === "owner abort") owner.abort();
    else current = false;
    gate.resolve();
    assert.deepEqual(await running, { kind: "stale" });
    assert.deepEqual(context.notifications, []);
  });
}

test("late factory rejection after cancellation is stale and never reported", async () => {
  const owner = new AbortController();
  const gate = deferred<void>();
  const started = deferred<void>();
  const failure = new Error("cancelled initialization failed");
  let reports = 0;
  const harness = createTuiHarness();
  const { ctx } = createMockContext({ mode: "tui", hasUI: true, custom: harness.custom });
  const running = runCustomInteraction(ctx, {
    signal: owner.signal,
    create: async () => {
      started.resolve();
      await gate.promise;
      throw failure;
    },
    onError: () => {
      reports++;
    },
  });
  await started.promise;
  owner.abort();
  await nextInputCycle();
  gate.resolve();
  assert.deepEqual(await running, { kind: "stale" });
  assert.equal(reports, 0);
});

test("a rejecting error reporter cannot notify a replaced owner", async () => {
  const gate = deferred<void>();
  const started = deferred<void>();
  const owner = new AbortController();
  const harness = createTuiHarness();
  const context = createMockContext({ mode: "tui", hasUI: true, custom: harness.custom });
  const running = runCustomInteraction(context.ctx, {
    signal: owner.signal,
    create: () => {
      throw new Error("initialization failed");
    },
    onError: async () => {
      started.resolve();
      await gate.promise;
      throw new Error("reporter failed");
    },
  });
  await started.promise;
  owner.abort();
  gate.resolve();
  assert.deepEqual(await running, { kind: "stale" });
  assert.equal(context.notifications.length, 0);
});

for (const mode of ["rpc", "print", "json"] as const) {
  test(`custom interaction rejects ${mode} without entering the terminal host`, async () => {
    let opens = 0;
    const { ctx } = createMockContext({
      mode,
      hasUI: mode === "rpc",
      custom: () => {
        opens++;
      },
    });
    const result = await runCustomInteraction(ctx, {
      create: () => {
        throw new Error("must not create");
      },
    });
    assert.deepEqual(result, { kind: "unsupported", mode });
    assert.equal(opens, 0);
  });
}

for (const phase of ["mounted pending", "late disposal"] as const) {
  for (const rejection of ["signal reason", "abort-aware promise", "unrelated abort", "unrelated error"] as const) {
    test(`${phase} preserves only completion-owned cancellation: ${rejection}`, async () => {
      const gate = deferred<void>();
      const pendingStarted = deferred<void>();
      const failure =
        rejection === "unrelated abort" ? new DOMException("other abort", "AbortError") : new Error("cleanup failed");
      const reports: unknown[] = [];
      let disposed = 0;
      let pendingDrained = false;
      const harness = createTuiHarness();
      const context = createMockContext({ mode: "tui", hasUI: true, custom: harness.custom });
      const running = runCustomInteraction(context.ctx, {
        create: async ({ complete, signal }) => {
          if (phase === "late disposal") complete("accepted");
          const reject = () => {
            if (rejection === "signal reason") signal.throwIfAborted();
            if (rejection === "abort-aware promise") {
              const abort = new Error("cancelled", { cause: signal.reason });
              abort.name = "AbortError";
              throw abort;
            }
            throw failure;
          };
          return {
            render: () => ["open"],
            invalidate() {},
            handleInput: () => complete("accepted"),
            dispose() {
              disposed++;
              if (phase === "late disposal") reject();
            },
            async waitForPending() {
              pendingStarted.resolve();
              await gate.promise;
              pendingDrained = true;
              if (phase === "mounted pending") {
                if (rejection === "abort-aware promise") await nextInputCycle(undefined, { signal });
                reject();
              }
            },
          };
        },
        onError: (_ctx, error) => {
          reports.push(error);
        },
      });
      if (phase === "mounted pending") {
        await harness.waitForOpen();
        harness.press("tui.select.confirm");
      }
      await pendingStarted.promise;
      gate.resolve();
      const expectedAbort = rejection === "signal reason" || rejection === "abort-aware promise";
      assert.deepEqual(
        await running,
        expectedAbort ? { kind: "completed", value: "accepted" } : { kind: "error", error: failure },
      );
      assert.equal(disposed, 1);
      assert.equal(pendingDrained, true);
      assert.deepEqual(reports, expectedAbort ? [] : [failure]);
      assert.deepEqual(context.notifications, []);
    });
  }
}

test("completion-owned pending cancellation cannot hide an unrelated disposal failure", async () => {
  const failure = new Error("disposal failed");
  const reports: unknown[] = [];
  const harness = createTuiHarness();
  const context = createMockContext({ mode: "tui", hasUI: true, custom: harness.custom });
  const result = await runCustomInteraction(context.ctx, {
    create: async ({ complete, signal }) => {
      complete("accepted");
      return {
        render: () => [],
        invalidate() {},
        dispose() {
          throw failure;
        },
        waitForPending: () => nextInputCycle(undefined, { signal }),
      };
    },
    onError: (_ctx, error) => {
      reports.push(error);
    },
  });
  assert.deepEqual(result, { kind: "error", error: failure });
  assert.deepEqual(reports, [failure]);
});

for (const transition of ["owner abort", "owner replaced"] as const) {
  test(`completion-owned pending cancellation is stale after ${transition}`, async () => {
    const owner = new AbortController();
    const gate = deferred<void>();
    const pendingStarted = deferred<void>();
    let current = true;
    const harness = createTuiHarness();
    const context = createMockContext({ mode: "tui", hasUI: true, custom: harness.custom });
    const running = runCustomInteraction(context.ctx, {
      signal: owner.signal,
      isCurrent: () => current,
      create: ({ complete, signal }) => ({
        render: () => ["open"],
        invalidate() {},
        handleInput: () => complete("accepted"),
        async waitForPending() {
          pendingStarted.resolve();
          await gate.promise;
          signal.throwIfAborted();
        },
      }),
    });
    await harness.waitForOpen();
    harness.press("tui.select.confirm");
    await pendingStarted.promise;
    if (transition === "owner abort") owner.abort();
    else current = false;
    gate.resolve();
    assert.deepEqual(await running, { kind: "stale" });
    assert.deepEqual(context.notifications, []);
  });
}

for (const current of [true, false]) {
  test(`pending cleanup failure is ${current ? "reported" : "suppressed after replacement"}`, async () => {
    let ownerCurrent = true;
    let disposed = 0;
    const gate = deferred<void>();
    const failure = new Error("cleanup failed");
    const harness = createTuiHarness();
    const context = createMockContext({ mode: "tui", hasUI: true, custom: harness.custom });
    const running = runCustomInteraction(context.ctx, {
      isCurrent: () => ownerCurrent,
      create: ({ complete }) => ({
        render: () => ["open"],
        invalidate() {},
        handleInput: () => complete("done"),
        dispose: () => {
          disposed++;
        },
        waitForPending: async () => {
          await gate.promise;
          throw failure;
        },
      }),
    });
    await harness.waitForOpen();
    harness.press("tui.select.confirm");
    ownerCurrent = current;
    gate.resolve();
    assert.deepEqual(await running, current ? { kind: "error", error: failure } : { kind: "stale" });
    assert.equal(disposed, 1);
    assert.equal(context.notifications.length, current ? 1 : 0);
  });
}
