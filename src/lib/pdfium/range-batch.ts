// SPDX-License-Identifier: MIT

export interface RangeBatch {
	startIndex: number;
	chunkIndexes: number[];
	hasRequiredChunk: boolean;
}

export interface RangeBatchPlanOptions {
	includeHints: boolean;
	maxChunkCount: number;
	maxChunksPerRequest: number;
}

export function createRangeBatchPlan(
	missingIndexes: Iterable<number>,
	hintedIndexes: Iterable<number>,
	options: RangeBatchPlanOptions,
): RangeBatch[] {
	const { includeHints, maxChunkCount, maxChunksPerRequest } = options;
	if (maxChunkCount < 1 || maxChunksPerRequest < 1) return [];

	const required = [...new Set(missingIndexes)].sort((left, right) => left - right);
	const requiredSet = new Set(required);
	const hinted = includeHints
		? [...new Set(hintedIndexes)]
				.filter((index) => !requiredSet.has(index))
				.sort((left, right) => left - right)
		: [];
	const selected = [...required, ...hinted]
		.slice(0, maxChunkCount)
		.sort((left, right) => left - right);
	const batches: RangeBatch[] = [];
	let current: RangeBatch | null = null;

	for (const index of selected) {
		const isRequired = requiredSet.has(index);
		if (
			current === null ||
			index !== current.chunkIndexes[current.chunkIndexes.length - 1] + 1 ||
			current.chunkIndexes.length >= maxChunksPerRequest
		) {
			current = { startIndex: index, chunkIndexes: [], hasRequiredChunk: false };
			batches.push(current);
		}
		current.chunkIndexes.push(index);
		current.hasRequiredChunk ||= isRequired;
	}

	return batches.sort(
		(left, right) =>
			Number(right.hasRequiredChunk) - Number(left.hasRequiredChunk) ||
			left.startIndex - right.startIndex,
	);
}
