import fs from "node:fs";

const files = process.argv.slice(2);

files.forEach((file) => {
	if (!fs.existsSync(file)) return;

	const content = fs.readFileSync(file, "utf8");

	const sortedLines = `${content
		.split(/\r?\n/)
		.filter((line) => line.trim() !== "")
		.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }))
		.join("\n")}\n`;

	fs.writeFileSync(file, sortedLines, "utf8");
});
