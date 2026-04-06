import * as assert from "node:assert";
import { RenderCoordinator } from "../../preview/renderCoordinator";

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

suite("RenderCoordinator", () => {
  test("schedule runs the job immediately", async () => {
    const coordinator = new RenderCoordinator({ debounceMs: 50, coalesceMs: 1000 });
    let ran = 0;
    coordinator.schedule(async () => {
      ran += 1;
    });
    await wait(20);
    assert.strictEqual(ran, 1);
    coordinator.dispose();
  });

  test("scheduleDebounced collapses rapid calls into one render", async () => {
    const coordinator = new RenderCoordinator({ debounceMs: 40, coalesceMs: 5000 });
    let ran = 0;
    for (let i = 0; i < 5; i += 1) {
      coordinator.scheduleDebounced(async () => {
        ran += 1;
      });
      await wait(10);
    }
    await wait(80);
    assert.strictEqual(ran, 1, "expected exactly one debounced render");
    coordinator.dispose();
  });

  test("only one job runs at a time and stale jobs are replaced", async () => {
    const coordinator = new RenderCoordinator({ debounceMs: 10, coalesceMs: 5000 });
    const order: string[] = [];
    let firstStarted = false;
    let releaseFirst: (() => void) | undefined;
    const firstDone = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    coordinator.schedule(async () => {
      firstStarted = true;
      order.push("first-start");
      await firstDone;
      order.push("first-end");
    });

    // Wait for first to actually begin.
    while (!firstStarted) {
      await wait(5);
    }

    coordinator.schedule(async () => {
      order.push("stale");
    });
    coordinator.schedule(async () => {
      order.push("latest");
    });

    releaseFirst?.();
    await wait(30);

    assert.deepStrictEqual(order, ["first-start", "first-end", "latest"]);
    coordinator.dispose();
  });

  test("coalescing timer forces a render during sustained typing", async () => {
    const coordinator = new RenderCoordinator({ debounceMs: 200, coalesceMs: 60 });
    let ran = 0;
    const start = Date.now();
    // Continuously reschedule debounced jobs faster than debounceMs so the
    // debounce timer never fires — the coalescing safeguard must kick in.
    const interval = setInterval(() => {
      coordinator.scheduleDebounced(async () => {
        ran += 1;
      });
    }, 20);

    while (ran === 0 && Date.now() - start < 500) {
      await wait(10);
    }
    clearInterval(interval);
    assert.ok(ran >= 1, "coalescing safeguard should force at least one render");
    coordinator.dispose();
  });

  test("dispose cancels pending work", async () => {
    const coordinator = new RenderCoordinator({ debounceMs: 30, coalesceMs: 1000 });
    let ran = 0;
    coordinator.scheduleDebounced(async () => {
      ran += 1;
    });
    coordinator.dispose();
    await wait(60);
    assert.strictEqual(ran, 0);
  });
});
