import { expect, test, vi } from "vitest";

import { PageTaskScheduler } from "./page-task-scheduler";

test("runs queued work by priority and promotes a shared queued task", async () => {
	const scheduler = new PageTaskScheduler({ maximumConcurrent: 1, reservedVisible: 0 });
	const first = createDeferred<string>();
	const calls: string[] = [];
	const active = scheduler.schedule({
		key: "active",
		priority: "visible",
		execute: () => first.promise,
	});
	const background = scheduler.schedule({
		key: "neighbor:2",
		priority: "prerender",
		execute: async () => {
			calls.push("neighbor");
			return "neighbor";
		},
	});
	const visible = scheduler.schedule({
		key: "visible:3",
		priority: "visible",
		execute: async () => {
			calls.push("visible");
			return "visible";
		},
	});
	const promoted = scheduler.schedule({
		key: "neighbor:2",
		priority: "visible",
		execute: async () => {
			calls.push("duplicate");
			return "duplicate";
		},
	});

	first.resolve("active");
	const leases = await Promise.all([active, visible, background, promoted]);
	expect(calls).toEqual(["neighbor", "visible"]);
	expect(leases[2]?.value).toBe("neighbor");
	expect(leases[3]?.value).toBe("neighbor");
	for (const lease of leases) lease?.release();
	scheduler.dispose();
});

test("cancelling one consumer preserves a task needed by another consumer", async () => {
	const scheduler = new PageTaskScheduler({ maximumConcurrent: 1, reservedVisible: 0 });
	const deferred = createDeferred<number>();
	const execution = vi.fn((signal: AbortSignal) => {
		expect(signal.aborted).toBe(false);
		return deferred.promise;
	});
	const firstController = new AbortController();
	const first = scheduler.schedule(
		{ key: "same-page:scale", priority: "prerender", execute: execution },
		firstController.signal,
	);
	const second = scheduler.schedule({
		key: "same-page:scale",
		priority: "visible",
		execute: execution,
	});

	firstController.abort();
	await expect(first).rejects.toMatchObject({ name: "AbortError" });
	expect(execution).toHaveBeenCalledOnce();

	deferred.resolve(42);
	const lease = await second;
	expect(lease.value).toBe(42);
	lease.release();
	scheduler.dispose();
});

test("releases a shared result once after every lease is released", async () => {
	const scheduler = new PageTaskScheduler({ maximumConcurrent: 1, reservedVisible: 0 });
	const releaseResult = vi.fn();
	const task = {
		key: "page:scale",
		priority: "visible" as const,
		execute: async () => ({ pixels: 10 }),
		releaseResult,
	};
	const [first, second] = await Promise.all([scheduler.schedule(task), scheduler.schedule(task)]);
	first?.release();
	first?.release();
	expect(releaseResult).not.toHaveBeenCalled();
	second?.release();
	expect(releaseResult).toHaveBeenCalledOnce();
	scheduler.dispose();
});

test("removes a completed null result after its final lease is released", async () => {
	const scheduler = new PageTaskScheduler({ maximumConcurrent: 1, reservedVisible: 0 });
	const firstExecute = vi.fn(async () => null);
	const firstLease = await scheduler.schedule({
		key: "optional-thumbnail",
		priority: "thumbnail",
		execute: firstExecute,
	});
	expect(firstLease.value).toBeNull();
	firstLease.release();

	const secondExecute = vi.fn(async () => "rendered");
	const secondLease = await scheduler.schedule({
		key: "optional-thumbnail",
		priority: "thumbnail",
		execute: secondExecute,
	});
	expect(secondExecute).toHaveBeenCalledOnce();
	expect(secondLease.value).toBe("rendered");
	secondLease.release();
	scheduler.dispose();
});

test("does not join a new consumer to an aborting task and releases its late result", async () => {
	const scheduler = new PageTaskScheduler({ maximumConcurrent: 2, reservedVisible: 0 });
	const oldResult = createDeferred<{ id: string }>();
	const releaseOldResult = vi.fn();
	const controller = new AbortController();
	const oldTask = scheduler.schedule(
		{
			key: "same-page:scale",
			priority: "prerender",
			execute: () => oldResult.promise,
			releaseResult: releaseOldResult,
		},
		controller.signal,
	);
	controller.abort();
	await expect(oldTask).rejects.toMatchObject({ name: "AbortError" });
	const newTask = scheduler.schedule({
		key: "same-page:scale",
		priority: "visible",
		execute: async () => ({ id: "new" }),
	});
	const newLease = await newTask;
	expect(newLease.value.id).toBe("new");
	newLease.release();

	oldResult.resolve({ id: "old" });
	await vi.waitFor(() => expect(releaseOldResult).toHaveBeenCalledOnce());
	scheduler.dispose();
});

test("keeps an aborting background task inside the reserved-slot count until it settles", async () => {
	const scheduler = new PageTaskScheduler({ maximumConcurrent: 2, reservedVisible: 1 });
	const oldBackground = createDeferred<string>();
	const visibleWork = createDeferred<string>();
	const started: string[] = [];
	const calls: string[] = [];
	const backgroundController = new AbortController();
	const oldTask = scheduler.schedule(
		{
			key: "background:old",
			priority: "data",
			execute: () => {
				started.push("old background");
				return oldBackground.promise;
			},
		},
		backgroundController.signal,
	);
	const visibleTask = scheduler.schedule({
		key: "visible:current",
		priority: "visible",
		execute: () => {
			started.push("visible");
			return visibleWork.promise;
		},
	});
	expect(started).toEqual(["old background", "visible"]);
	backgroundController.abort();
	await expect(oldTask).rejects.toMatchObject({ name: "AbortError" });

	const queuedBackground = scheduler.schedule({
		key: "background:new",
		priority: "data",
		execute: async () => {
			calls.push("new background");
			return "new";
		},
	});
	visibleWork.resolve("visible");
	const visibleLease = await visibleTask;
	visibleLease.release();
	await Promise.resolve();
	expect(calls).toEqual([]);

	oldBackground.resolve("late old result");
	const queuedLease = await queuedBackground;
	expect(calls).toEqual(["new background"]);
	queuedLease.release();
	scheduler.dispose();
});

test("rejects a task whose executor throws synchronously", async () => {
	const scheduler = new PageTaskScheduler({ maximumConcurrent: 1, reservedVisible: 0 });
	const failure = new Error("synchronous executor failure");
	const scheduled = scheduler.schedule({
		key: "broken",
		priority: "visible",
		execute: () => {
			throw failure;
		},
	});
	await expect(scheduled).rejects.toBe(failure);
	scheduler.dispose();
});

function createDeferred<Value>(): {
	promise: Promise<Value>;
	resolve(value: Value): void;
} {
	let resolve: (value: Value) => void = () => undefined;
	const promise = new Promise<Value>((complete) => {
		resolve = complete;
	});
	return { promise, resolve };
}
