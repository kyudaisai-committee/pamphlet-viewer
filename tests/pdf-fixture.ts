import { Buffer } from "node:buffer";

const PAGE_COUNT = 24;
const FILLER_BYTES = 32 * 1024 * 1024;
const TRAILING_FILLER_BYTES = 1024 * 1024;
const FAR_PAGE_COLOR = [0.91, 0.08, 0.16] as const;

export interface PdfFixtureOptions {
	tinyPageNumbers?: readonly number[];
	contentGapBytes?: number;
	midDocumentFillerBytes?: number;
	rotatedCropPageNumber?: number;
}

export function createPdfFixture(options: PdfFixtureOptions = {}): Buffer {
	const chunks: Buffer[] = [Buffer.from("%PDF-1.7\n", "ascii")];
	const offsets: number[] = [0];
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
		const pageObject = 3 + index;
		const contentObject = 3 + PAGE_COUNT + index;
		const tinyPage = options.tinyPageNumbers?.includes(index + 1) ?? false;
		const mediaBox = tinyPage ? "0 0 24 24" : "0 0 300 400";
		const rotatedCropPage = options.rotatedCropPageNumber === index + 1;
		const pageGeometry = rotatedCropPage
			? "/CropBox [25 40 225 340] /Rotate 90"
			: options.rotatedCropPageNumber === undefined
				? `/MediaBox [${mediaBox}]`
				: "/MediaBox [0 0 300 400]";
		const pageBody = `<< /Type /Page /Parent 2 0 R ${pageGeometry} /Resources << >> /Contents ${contentObject} 0 R >>`;
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
		const rectangle = tinyPage ? "2 2 20 20" : "30 40 240 320";
		const stream = `q\n${color[0]} ${color[1]} ${color[2]} rg\n${rectangle} re\nf\nQ\n`;
		const contentBody = `<< /Length ${Buffer.byteLength(stream, "ascii")} >>\nstream\n${stream}endstream`;
		appendObject(chunks, offsets, contentObject, contentBody, position);
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
	body: string,
	position: number,
): void {
	const chunk = Buffer.from([`${objectNumber} 0 obj`, body, "endobj", ""].join("\n"), "ascii");
	offsets[objectNumber] = position;
	chunks.push(chunk);
}
