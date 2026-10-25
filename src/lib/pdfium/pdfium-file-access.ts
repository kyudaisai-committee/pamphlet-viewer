const FILE_ACCESS_SIZE = 12;
const FILE_AVAIL_SIZE = 8;
const DOWNLOAD_HINTS_SIZE = 8;

type BlockCallback = (parameter: number, position: number, buffer: number, size: number) => number;
type AvailabilityCallback = (fileAvail: number, offset: number, size: number) => number;
type DownloadHintCallback = (hints: number, offset: number, size: number) => void;
type NativeCallback = BlockCallback | AvailabilityCallback | DownloadHintCallback;

export interface PdfiumRuntimeApi {
	malloc(size: number): number;
	free(pointer: number): void;
	addFunction(callback: NativeCallback, signature: string): number;
	removeFunction(pointer: number): void;
	setValue(pointer: number, value: number, type: "i32"): void;
	getHeap(): Uint8Array;
}

interface RangeReader {
	readInto(position: number, target: Uint8Array, targetOffset: number, length: number): boolean;
	isRangeAvailable(position: number, length: number): boolean;
	hintRange(position: number, length: number): void;
}

export class PdfiumFileAccess {
	#fileAccess = 0;
	#fileAvail = 0;
	#downloadHints = 0;
	#blockCallback = 0;
	#availabilityCallback = 0;
	#downloadHintCallback = 0;
	#disposed = false;

	constructor(
		private readonly runtime: PdfiumRuntimeApi,
		private readonly fileLength: number,
		private readonly reader: RangeReader,
		private readonly recordCallbackError: (error: unknown) => void,
		private readonly recordCleanupError: (error: unknown) => void,
	) {}

	get fileAccess(): number {
		return this.#fileAccess;
	}

	get fileAvail(): number {
		return this.#fileAvail;
	}

	get downloadHints(): number {
		return this.#downloadHints;
	}

	initialize(): void {
		if (this.#fileAccess !== 0) throw new Error("PDFium file access is already initialized.");
		this.#fileAccess = this.#allocate(FILE_ACCESS_SIZE);
		this.#fileAvail = this.#allocate(FILE_AVAIL_SIZE);
		this.#downloadHints = this.#allocate(DOWNLOAD_HINTS_SIZE);

		const readBlock: BlockCallback = (_parameter, position, buffer, size): number => {
			try {
				return this.reader.readInto(
					toUnsignedI32(position),
					this.runtime.getHeap(),
					toUnsignedI32(buffer),
					toUnsignedI32(size),
				)
					? 1
					: 0;
			} catch (error) {
				this.recordCallbackError(error);
				return 0;
			}
		};
		const isDataAvailable: AvailabilityCallback = (_fileAvail, offset, size): number => {
			try {
				return this.reader.isRangeAvailable(toUnsignedI32(offset), toUnsignedI32(size)) ? 1 : 0;
			} catch (error) {
				this.recordCallbackError(error);
				return 0;
			}
		};
		const addDownloadSegment: DownloadHintCallback = (_hints, offset, size): void => {
			try {
				this.reader.hintRange(toUnsignedI32(offset), toUnsignedI32(size));
			} catch (error) {
				this.recordCallbackError(error);
			}
		};

		this.#blockCallback = this.#registerCallback(readBlock, "iiiii");
		this.#availabilityCallback = this.#registerCallback(isDataAvailable, "iiii");
		this.#downloadHintCallback = this.#registerCallback(addDownloadSegment, "viii");
		this.runtime.setValue(this.#fileAccess, this.fileLength, "i32");
		this.runtime.setValue(this.#fileAccess + 4, this.#blockCallback, "i32");
		this.runtime.setValue(this.#fileAccess + 8, 0, "i32");
		this.runtime.setValue(this.#fileAvail, 1, "i32");
		this.runtime.setValue(this.#fileAvail + 4, this.#availabilityCallback, "i32");
		this.runtime.setValue(this.#downloadHints, 1, "i32");
		this.runtime.setValue(this.#downloadHints + 4, this.#downloadHintCallback, "i32");
	}

	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;

		for (const pointer of [
			this.#downloadHintCallback,
			this.#availabilityCallback,
			this.#blockCallback,
		]) {
			if (!this.#removeCallback(pointer)) return;
		}
		this.#downloadHintCallback = 0;
		this.#availabilityCallback = 0;
		this.#blockCallback = 0;

		for (const pointer of [this.#downloadHints, this.#fileAvail, this.#fileAccess]) {
			if (!this.#free(pointer)) return;
		}
		this.#downloadHints = 0;
		this.#fileAvail = 0;
		this.#fileAccess = 0;
	}

	#allocate(size: number): number {
		const pointer = this.runtime.malloc(size);
		if (pointer === 0) throw new Error("Could not allocate PDFium range availability data.");
		return pointer;
	}

	#registerCallback(callback: NativeCallback, signature: string): number {
		const pointer = this.runtime.addFunction(callback, signature);
		if (pointer === 0) throw new Error("Could not register a PDFium range callback.");
		return pointer;
	}

	#removeCallback(pointer: number): boolean {
		if (pointer === 0) return true;
		try {
			this.runtime.removeFunction(pointer);
			return true;
		} catch (error) {
			this.recordCleanupError(error);
			return false;
		}
	}

	#free(pointer: number): boolean {
		if (pointer === 0) return true;
		try {
			this.runtime.free(pointer);
			return true;
		} catch (error) {
			this.recordCleanupError(error);
			return false;
		}
	}
}

function toUnsignedI32(value: number): number {
	return value >>> 0;
}
