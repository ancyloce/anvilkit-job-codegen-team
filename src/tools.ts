// `node dist/tools.js --check|--write <file>`: the reviewed tools document
// (agent/team/tools.json) generated from the team's schemas and the Pi
// SDK's file tools; --check refuses drift so the Proxy's route configuration
// and the coder always name the same schemas.
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { packageRoot } from "./contracts.js";
import { reviewedToolsDocument } from "./team/tools.js";

const defaultPath = path.resolve(packageRoot, "agent", "team", "tools.json");

function main(argv: string[]): number {
	const mode = argv[0] ?? "--check";
	const file = argv[1] ?? defaultPath;
	const text = `${JSON.stringify(reviewedToolsDocument(), null, 2)}\n`;
	if (mode === "--write") {
		writeFileSync(file, text);
		process.stdout.write(`wrote ${file}\n`);
		return 0;
	}
	if (mode !== "--check") {
		process.stderr.write("usage: tools.js --check|--write [file]\n");
		return 2;
	}
	let current: string;
	try {
		current = readFileSync(file, "utf8");
	} catch (err) {
		process.stderr.write(`${file}: ${(err as Error).message}\n`);
		return 1;
	}
	if (current !== text) {
		process.stderr.write(
			`${file} differs from the reviewed tools of this build; regenerate with --write after review\n`,
		);
		return 1;
	}
	process.stdout.write(`${file}: ${JSON.parse(text).tools.length} reviewed tools, no drift\n`);
	return 0;
}

const invokedDirectly =
	process.argv[1] !== undefined && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);
if (invokedDirectly) process.exit(main(process.argv.slice(2)));
