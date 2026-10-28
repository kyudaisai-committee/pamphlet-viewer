import { Buffer } from "node:buffer";

const PAGE_COUNT = 24;
const FILLER_BYTES = 32 * 1024 * 1024;
const TRAILING_FILLER_BYTES = 1024 * 1024;
const FAR_PAGE_COLOR = [0.91, 0.08, 0.16] as const;

export interface PdfFixtureOptions {
	tinyPageNumbers?: readonly number[];
	pageSizes?: readonly { width: number; height: number }[];
	contentGapBytes?: number;
	midDocumentFillerBytes?: number;
	rotatedCropPageNumber?: number;
	thumbnailPageNumbers?: readonly number[];
	indexedThumbnailPageNumbers?: readonly number[];
	imagePageNumbers?: readonly number[];
	pageObjectGapBytes?: number;
}

export function createPdfFixture(options: PdfFixtureOptions = {}): Buffer {
	const chunks: Buffer[] = [Buffer.from("%PDF-1.7\n", "ascii")];
	const offsets: number[] = [0];
	const thumbnailPageNumbers = getThumbnailPageNumbers(options.thumbnailPageNumbers);
	const indexedThumbnailPageNumbers = new Set(
		getThumbnailPageNumbers(options.indexedThumbnailPageNumbers),
	);
	const imagePageNumbers = getImagePageNumbers(options.imagePageNumbers);
	const thumbnailObjectByPageNumber = new Map(
		thumbnailPageNumbers.map((pageNumber, index) => [pageNumber, 3 + PAGE_COUNT * 2 + index]),
	);
	const imageObjectByPageNumber = new Map(
		imagePageNumbers.map((pageNumber, index) => [
			pageNumber,
			3 + PAGE_COUNT * 2 + thumbnailPageNumbers.length + index,
		]),
	);
	let position = chunks[0].byteLength;

	appendObject(chunks, offsets, 1, "<< /Type /Catalog /Pages 2 0 R >>", position);
	position += chunks.at(-1)?.byteLength ?? 0;

	const pageReferences = Array.from({ length: PAGE_COUNT }, (_, index) => {
		const pageObject = 3 + index;
		return `${pageObject} 0 R`;
	});
	const inheritedMediaBox =
		options.rotatedCropPageNumber === undefined ? "" : " /MediaBox [0 0 300 400]";
	const pagesObject = `<< /Type /Pages /Count ${PAGE_COUNT} /Kids [${pageReferences.join(" ")}]${inheritedMediaBox} >>`;
	appendObject(chunks, offsets, 2, pagesObject, position);
	position += chunks.at(-1)?.byteLength ?? 0;

	for (let index = 0; index < PAGE_COUNT; index += 1) {
		const pageObjectGapBytes = options.pageObjectGapBytes ?? 0;
		if (index > 0 && pageObjectGapBytes > 0) {
			appendFiller(chunks, pageObjectGapBytes);
			position += pageObjectGapBytes;
		}
		const pageObject = 3 + index;
		const contentObject = 3 + PAGE_COUNT + index;
		const tinyPage = options.tinyPageNumbers?.includes(index + 1) ?? false;
		const pageSize = options.pageSizes?.[index] ?? { width: 300, height: 400 };
		const mediaBox = tinyPage ? "0 0 24 24" : `0 0 ${pageSize.width} ${pageSize.height}`;
		const rotatedCropPage = options.rotatedCropPageNumber === index + 1;
		const pageGeometry = rotatedCropPage
			? "/CropBox [25 40 225 340] /Rotate 90"
			: options.rotatedCropPageNumber === undefined
				? `/MediaBox [${mediaBox}]`
				: "/MediaBox [0 0 300 400]";
		const thumbnailObject = thumbnailObjectByPageNumber.get(index + 1);
		const imageObject = imageObjectByPageNumber.get(index + 1);
		const thumbnailReference =
			thumbnailObject === undefined ? "" : ` /Thumb ${thumbnailObject} 0 R`;
		const resources =
			imageObject === undefined ? "<< >>" : `<< /XObject << /Im0 ${imageObject} 0 R >> >>`;
		const pageBody = `<< /Type /Page /Parent 2 0 R ${pageGeometry} /Resources ${resources} /Contents ${contentObject} 0 R${thumbnailReference} >>`;
		appendObject(chunks, offsets, pageObject, pageBody, position);
		position += chunks.at(-1)?.byteLength ?? 0;
	}

	for (let index = 0; index < PAGE_COUNT; index += 1) {
		if (index === PAGE_COUNT / 2) {
			const fillerBytes = options.midDocumentFillerBytes ?? FILLER_BYTES;
			if (fillerBytes > 0) {
				appendFiller(chunks, fillerBytes);
				position += fillerBytes;
			}
		}

		const contentGapBytes = options.contentGapBytes ?? 0;
		if (contentGapBytes > 0) {
			appendFiller(chunks, contentGapBytes);
			position += contentGapBytes;
		}

		const contentObject = 3 + PAGE_COUNT + index;
		const color = getPageColor(index);
		const tinyPage = options.tinyPageNumbers?.includes(index + 1) ?? false;
		const pageSize = options.pageSizes?.[index] ?? { width: 300, height: 400 };
		const rectangle = tinyPage
			? "2 2 20 20"
			: `30 40 ${pageSize.width - 60} ${pageSize.height - 80}`;
		const imageObject = imageObjectByPageNumber.get(index + 1);
		const stream =
			imageObject === undefined
				? `q\n${color[0]} ${color[1]} ${color[2]} rg\n${rectangle} re\nf\nQ\n`
				: "q\n300 0 0 400 0 0 cm\n/Im0 Do\nQ\n";
		const contentBody = `<< /Length ${Buffer.byteLength(stream, "ascii")} >>\nstream\n${stream}endstream`;
		appendObject(chunks, offsets, contentObject, contentBody, position);
		position += chunks.at(-1)?.byteLength ?? 0;
	}
	for (const pageNumber of thumbnailPageNumbers) {
		const thumbnailObject = thumbnailObjectByPageNumber.get(pageNumber);
		if (thumbnailObject === undefined) continue;
		const indexed = indexedThumbnailPageNumbers.has(pageNumber);
		const imageData = indexed ? "0001".repeat(6) : "00FF00".repeat(12);
		const stream = `${imageData}>\n`;
		const thumbnailBody = [
			indexed
				? "<< /Type /XObject /Subtype /Image /Width 3 /Height 4 /ColorSpace [/Indexed /DeviceRGB 1 <FF00000000FF>] /BitsPerComponent 8"
				: "<< /Type /XObject /Subtype /Image /Width 3 /Height 4 /ColorSpace /DeviceRGB /BitsPerComponent 8",
			`/Filter /ASCIIHexDecode /Length ${Buffer.byteLength(stream, "ascii")} >>`,
			"stream",
			stream.trimEnd(),
			"endstream",
		].join("\n");
		appendObject(chunks, offsets, thumbnailObject, thumbnailBody, position);
		position += chunks.at(-1)?.byteLength ?? 0;
	}
	for (const [index, pageNumber] of imagePageNumbers.entries()) {
		const objectNumber = imageObjectByPageNumber.get(pageNumber);
		if (objectNumber === undefined) continue;
		const imageBytes = Buffer.alloc(256 * 256 * 3, 0x80 + (index % 64));
		const imageBody = Buffer.concat([
			Buffer.from(
				`<< /Type /XObject /Subtype /Image /Width 256 /Height 256 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Length ${imageBytes.byteLength} >>\nstream\n`,
				"ascii",
			),
			imageBytes,
			Buffer.from("\nendstream", "ascii"),
		]);
		appendObject(chunks, offsets, objectNumber, imageBody, position);
		position += chunks.at(-1)?.byteLength ?? 0;
	}
	appendFiller(chunks, TRAILING_FILLER_BYTES);
	position += TRAILING_FILLER_BYTES;

	const objectCount = offsets.length;
	const xrefOffset = position;
	const xrefLines = ["xref", `0 ${objectCount}`, "0000000000 65535 f "];
	for (const offset of offsets.slice(1)) {
		xrefLines.push(`${offset.toString().padStart(10, "0")} 00000 n `);
	}
	const trailer = [
		"trailer",
		`<< /Size ${objectCount} /Root 1 0 R >>`,
		"startxref",
		`${xrefOffset}`,
		"%%EOF",
		"",
	].join("\n");
	chunks.push(Buffer.from(`${xrefLines.join("\n")}\n${trailer}`, "ascii"));

	return Buffer.concat(chunks);
}

function getThumbnailPageNumbers(pageNumbers: readonly number[] | undefined): number[] {
	if (pageNumbers === undefined) return [];
	return [...new Set(pageNumbers)].filter(
		(pageNumber) =>
			Number.isSafeInteger(pageNumber) && pageNumber >= 1 && pageNumber <= PAGE_COUNT,
	);
}

function getImagePageNumbers(pageNumbers: readonly number[] | undefined): number[] {
	if (pageNumbers === undefined) return [];
	return [...new Set(pageNumbers)].filter(
		(pageNumber) =>
			Number.isSafeInteger(pageNumber) && pageNumber >= 1 && pageNumber <= PAGE_COUNT,
	);
}

export function createAnnotatedPdfFixture(): Buffer {
	const backgroundStream = "q\n0.12 0.34 0.72 rg\n0 0 300 400 re\nf\nQ\n";
	const appearanceStream = "q\n1 0 0 rg\n0 0 100 100 re\nf\nQ\n";
	const objects = [
		"<< /Type /Catalog /Pages 2 0 R >>",
		"<< /Type /Pages /Count 1 /Kids [3 0 R] >>",
		"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 400] /Resources << >> /Contents 4 0 R /Annots [5 0 R] >>",
		`<< /Length ${Buffer.byteLength(backgroundStream, "ascii")} >>\nstream\n${backgroundStream}endstream`,
		"<< /Type /Annot /Subtype /Square /Rect [100 150 200 250] /C [1 0 0] /IC [1 0 0] /Border [0 0 0] /F 4 /P 3 0 R /AP << /N 6 0 R >> >>",
		`<< /Type /XObject /Subtype /Form /BBox [0 0 100 100] /Resources << >> /Length ${Buffer.byteLength(appearanceStream, "ascii")} >>\nstream\n${appearanceStream}endstream`,
	];
	const chunks: Buffer[] = [Buffer.from("%PDF-1.7\n", "ascii")];
	const offsets: number[] = [0];
	let position = chunks[0].byteLength;

	for (const [index, body] of objects.entries()) {
		const objectNumber = index + 1;
		appendObject(chunks, offsets, objectNumber, body, position);
		position += chunks.at(-1)?.byteLength ?? 0;
	}

	const xrefOffset = position;
	const xrefLines = ["xref", `0 ${offsets.length}`, "0000000000 65535 f "];
	for (const offset of offsets.slice(1)) {
		xrefLines.push(`${offset.toString().padStart(10, "0")} 00000 n `);
	}
	const trailer = [
		"trailer",
		`<< /Size ${offsets.length} /Root 1 0 R >>`,
		"startxref",
		`${xrefOffset}`,
		"%%EOF",
		"",
	].join("\n");
	chunks.push(Buffer.from(`${xrefLines.join("\n")}\n${trailer}`, "ascii"));
	return Buffer.concat(chunks);
}

function appendFiller(chunks: Buffer[], byteLength: number): void {
	const filler = Buffer.alloc(byteLength, 0x78);
	filler[0] = 0x25;
	filler[filler.byteLength - 1] = 0x0a;
	chunks.push(filler);
}

function getPageColor(index: number): readonly [number, number, number] {
	if (index === PAGE_COUNT - 1) return FAR_PAGE_COLOR;
	return [0.12, 0.34, 0.72];
}

function appendObject(
	chunks: Buffer[],
	offsets: number[],
	objectNumber: number,
	body: string | Buffer,
	position: number,
): void {
	const chunk =
		typeof body === "string"
			? Buffer.from([`${objectNumber} 0 obj`, body, "endobj", ""].join("\n"), "ascii")
			: Buffer.concat([
					Buffer.from(`${objectNumber} 0 obj\n`, "ascii"),
					body,
					Buffer.from("\nendobj\n", "ascii"),
				]);
	offsets[objectNumber] = position;
	chunks.push(chunk);
}
