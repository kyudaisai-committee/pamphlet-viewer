// SPDX-License-Identifier: MIT

export class RangeChunkCache {
	#chunks = new Map<number, Uint8Array>();
	#byteLength = 0;

	constructor(
		private readonly maxBytes: number,
		private readonly lowWatermark: number,
	) {}

	get byteLength(): number {
		return this.#byteLength;
	}

	get(index: number): Uint8Array | undefined {
		const chunk = this.#chunks.get(index);
		if (chunk === undefined) return undefined;

		this.#chunks.delete(index);
		this.#chunks.set(index, chunk);
		return chunk;
	}

	clear(): void {
		this.#chunks.clear();
		this.#byteLength = 0;
	}

	set(index: number, chunk: Uint8Array): boolean {
		let evicted = false;
		const existing = this.#chunks.get(index);
		if (existing !== undefined) {
			this.#byteLength -= existing.byteLength;
			this.#chunks.delete(index);
		}
		if (chunk.byteLength > this.maxBytes) return false;

		if (this.#byteLength + chunk.byteLength > this.maxBytes) {
			while (this.#byteLength > this.lowWatermark) {
				const oldest = this.#chunks.entries().next().value as
					| [number, Uint8Array]
					| undefined;
				if (oldest === undefined) break;
				this.#chunks.delete(oldest[0]);
				this.#byteLength -= oldest[1].byteLength;
				evicted = true;
			}
			while (this.#byteLength + chunk.byteLength > this.maxBytes) {
				const oldest = this.#chunks.entries().next().value as
					| [number, Uint8Array]
					| undefined;
				if (oldest === undefined) break;
				this.#chunks.delete(oldest[0]);
				this.#byteLength -= oldest[1].byteLength;
				evicted = true;
			}
		}

		this.#chunks.set(index, chunk);
		this.#byteLength += chunk.byteLength;
		return evicted;
	}
}
