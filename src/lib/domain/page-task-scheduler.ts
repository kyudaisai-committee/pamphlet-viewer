// SPDX-License-Identifier: MIT

export type PageTaskPriority = "visible" | "data" | "prerender" | "thumbnail";

export interface PageTaskLease<Result> {
	readonly value: Result;
	release(): void;
}

export interface PageTask<Result> {
	readonly key: string;
	readonly priority: PageTaskPriority;
	execute(signal: AbortSignal): Promise<Result>;
	releaseResult?(result: Result): void;
}

export interface PageTaskSchedulerOptions {
	maximumConcurrent: number;
	reservedVisible: number;
}

interface PageTaskWaiter<Result> {
	resolve(lease: PageTaskLease<Result>): void;
	reject(error: unknown): void;
	signal: AbortSignal | undefined;
	abortListener: (() => void) | null;
}

interface ScheduledTask<Result> extends Omit<PageTask<Result>, "priority"> {
	priority: PageTaskPriority;
	sequence: number;
	state: "queued" | "running" | "aborting" | "complete";
	waiters: Set<PageTaskWaiter<Result>>;
	controller: AbortController | null;
	result: Result | null;
	leaseCount: number;
}

export class PageTaskScheduler {
	#tasks = new Map<string, ScheduledTask<unknown>>();
	#queue: ScheduledTask<unknown>[] = [];
	#active = 0;
	#sequence = 0;
	#disposed = false;

	constructor(private readonly options: PageTaskSchedulerOptions) {
		if (!Number.isSafeInteger(options.maximumConcurrent) || options.maximumConcurrent < 1) {
			throw new RangeError("The task scheduler needs at least one concurrent slot.");
		}
		if (
			!Number.isSafeInteger(options.reservedVisible) ||
			options.reservedVisible < 0 ||
			options.reservedVisible >= options.maximumConcurrent
		) {
			throw new RangeError("Reserved visible slots must be below the concurrency limit.");
		}
	}

	schedule<Result>(task: PageTask<Result>, signal?: AbortSignal): Promise<PageTaskLease<Result>> {
		if (this.#disposed) return Promise.reject(createAbortError());
		if (signal?.aborted) return Promise.reject(createAbortError());

		let scheduled = this.#tasks.get(task.key) as ScheduledTask<Result> | undefined;
		if (scheduled === undefined) {
			scheduled = {
				...task,
				sequence: this.#sequence,
				state: "queued",
				waiters: new Set(),
				controller: null,
				result: null,
				leaseCount: 0,
			};
			this.#sequence += 1;
			this.#tasks.set(task.key, scheduled as ScheduledTask<unknown>);
			this.#queue.push(scheduled as ScheduledTask<unknown>);
		} else if (scheduled.state === "complete") {
			return Promise.resolve(this.#createLease(scheduled));
		} else if (getPriorityRank(task.priority) < getPriorityRank(scheduled.priority)) {
			scheduled.priority = task.priority;
		}

		const waiter = this.#createWaiter(scheduled, signal);
		return new Promise((resolve, reject) => {
			waiter.resolve = resolve;
			waiter.reject = reject;
			this.#drain();
		});
	}

	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		for (const task of this.#tasks.values()) {
			for (const waiter of [...task.waiters])
				this.#removeWaiter(task, waiter, createAbortError());
			if (task.state === "running") task.controller?.abort();
			if (task.state === "complete" && task.leaseCount === 0 && task.result !== null) {
				task.releaseResult?.(task.result);
				task.result = null;
			}
		}
		this.#queue = [];
		this.#tasks.clear();
	}

	#createWaiter<Result>(
		task: ScheduledTask<Result>,
		signal?: AbortSignal,
	): PageTaskWaiter<Result> {
		const waiter: PageTaskWaiter<Result> = {
			resolve: () => undefined,
			reject: () => undefined,
			signal,
			abortListener: null,
		};
		if (signal !== undefined) {
			waiter.abortListener = () => this.#removeWaiter(task, waiter, createAbortError());
			signal.addEventListener("abort", waiter.abortListener, { once: true });
		}
		task.waiters.add(waiter);
		return waiter;
	}

	#removeWaiter<Result>(
		task: ScheduledTask<Result>,
		waiter: PageTaskWaiter<Result>,
		error: unknown,
	): void {
		if (!task.waiters.delete(waiter)) return;
		if (waiter.abortListener !== null) {
			waiter.signal?.removeEventListener("abort", waiter.abortListener);
			waiter.abortListener = null;
		}
		waiter.reject(error);
		if (task.waiters.size !== 0) return;
		if (task.state === "queued") {
			this.#removeTask(task);
			return;
		}
		if (task.state === "running") {
			task.state = "aborting";
			this.#removeTask(task);
			task.controller?.abort();
		}
	}

	#drain(): void {
		if (this.#disposed) return;
		this.#queue.sort((left, right) => {
			const priority = getPriorityRank(left.priority) - getPriorityRank(right.priority);
			return priority || left.sequence - right.sequence;
		});
		while (this.#active < this.options.maximumConcurrent && this.#queue.length > 0) {
			const index = this.#queue.findIndex((task) => this.#canStart(task));
			if (index < 0) return;
			const task = this.#queue.splice(index, 1)[0];
			if (task === undefined) continue;
			this.#active += 1;
			task.state = "running";
			task.controller = new AbortController();
			void this.#run(task);
		}
	}

	#canStart(task: ScheduledTask<unknown>): boolean {
		if (task.priority === "visible") return true;
		const backgroundCount = [...this.#tasks.values()].filter(
			(candidate) =>
				(candidate.state === "running" || candidate.state === "aborting") &&
				candidate.priority !== "visible",
		).length;
		return backgroundCount < this.options.maximumConcurrent - this.options.reservedVisible;
	}

	async #run<Result>(task: ScheduledTask<Result>): Promise<void> {
		try {
			const result = await task.execute(task.controller?.signal ?? AbortSignal.abort());
			task.result = result;
			task.state = "complete";
			if (task.waiters.size === 0 || this.#disposed) {
				task.releaseResult?.(result);
				task.result = null;
				this.#removeTask(task);
				return;
			}
			for (const waiter of [...task.waiters]) {
				task.waiters.delete(waiter);
				if (waiter.abortListener !== null) {
					waiter.signal?.removeEventListener("abort", waiter.abortListener);
					waiter.abortListener = null;
				}
				waiter.resolve(this.#createLease(task));
			}
		} catch (error) {
			for (const waiter of [...task.waiters]) {
				this.#removeWaiter(task, waiter, error);
			}
			this.#removeTask(task);
		} finally {
			this.#active -= 1;
			this.#drain();
		}
	}

	#createLease<Result>(task: ScheduledTask<Result>): PageTaskLease<Result> {
		task.leaseCount += 1;
		let released = false;
		return {
			value: task.result as Result,
			release: () => {
				if (released) return;
				released = true;
				task.leaseCount -= 1;
				if (task.leaseCount !== 0 || task.result === null) return;
				task.releaseResult?.(task.result);
				task.result = null;
				this.#removeTask(task);
			},
		};
	}

	#removeTask(task: ScheduledTask<unknown>): void {
		this.#queue = this.#queue.filter((queued) => queued !== task);
		if (this.#tasks.get(task.key) === task) this.#tasks.delete(task.key);
	}
}

function getPriorityRank(priority: PageTaskPriority): number {
	if (priority === "visible") return 0;
	if (priority === "data") return 1;
	if (priority === "prerender") return 2;
	return 3;
}

function createAbortError(): DOMException {
	return new DOMException("The page task was cancelled.", "AbortError");
}
