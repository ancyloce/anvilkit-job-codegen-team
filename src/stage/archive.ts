// The stage's archive operations: reproducible tar archives of sealed files
// (fixed mtime, sorted entries, no link followed), and the strict reading
// recovery proofs rely on — regular files only, each member name once,
// normalized relative paths within the source limits when unpacked.
import { createHash } from "node:crypto";
import { createReadStream, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import * as tar from "tar";
import { type Digest, sequence, sha256 } from "../digest.js";
import type { SourceLimits } from "../source.js";
import { type ObjectRef, StageRefusedError } from "./manifest.js";

/** Fixed mtime of every archive entry (npm's choice for reproducible packs). */
export const archiveMtime = new Date("1985-10-26T08:15:00.000Z");

/** Archives entries (relative to cwd, sorted) into file and returns its digest and size. */
export async function archive(file: string, cwd: string, entries: string[]): Promise<ObjectRef> {
	await tar.create(
		{ portable: true, mtime: archiveMtime, cwd, noDirRecurse: true, file, follow: false },
		[...entries].sort(),
	);
	const bytes = readFileSync(file);
	return { digest: sha256(bytes), sizeBytes: sequence(bytes.length) };
}

/**
 * Reads the members of a tar archive: regular files only, each name once
 * (a second member of one name would let a reader see other bytes than the
 * proof did), anything else refuses the archive. onMember receives each
 * member's chunks.
 */
async function readMembers(
	source: NodeJS.ReadableStream,
	onMember: (name: string) => { data: (c: Buffer) => void; end: () => void },
): Promise<void> {
	const seen = new Set<string>();
	let failure: Error | undefined;
	await new Promise<void>((resolve, reject) => {
		const parser = new tar.Parser({
			strict: true,
			onReadEntry(entry) {
				if (entry.type !== "File" || seen.has(entry.path)) {
					failure ??= new StageRefusedError(
						"STALE_STAGE",
						entry.type !== "File"
							? `${entry.path}: archive entry of type ${entry.type} is not a regular file`
							: `${entry.path}: the archive holds this member twice`,
					);
					entry.resume();
					return;
				}
				seen.add(entry.path);
				const sink = onMember(entry.path);
				entry.on("data", sink.data);
				entry.on("end", sink.end);
			},
		});
		parser.on("error", reject);
		parser.on("end", resolve);
		source.on("error", reject);
		source.pipe(parser);
	});
	if (failure) throw failure;
}

/** The regular-file members of a tar archive with their bytes. */
export async function tarMembers(bytes: Buffer): Promise<Map<string, Buffer>> {
	const out = new Map<string, Buffer>();
	await readMembers(Readable.from([bytes]), (name) => {
		const chunks: Buffer[] = [];
		return { data: (c) => chunks.push(c), end: () => out.set(name, Buffer.concat(chunks)) };
	});
	return out;
}

/** The members of a tar file with their digests. */
export async function tarInventory(file: string): Promise<Map<string, Digest>> {
	const out = new Map<string, Digest>();
	await readMembers(createReadStream(file), (name) => {
		const h = createHash("sha256");
		return { data: (c) => h.update(c), end: () => out.set(name, `sha256:${h.digest("hex")}`) };
	});
	return out;
}

/** One regular-file member of a tar archive, or undefined. */
export async function stageArchiveMember(bytes: Buffer, name: string): Promise<Buffer | undefined> {
	return (await tarMembers(bytes)).get(name);
}

const pathSegment = /^[A-Za-z0-9_@.-]+$/;

/** Unpacks a source archive into dir: regular files under normalized relative paths only, bounded by the source limits. */
export async function unpackTar(bytes: Buffer, dir: string, limits: SourceLimits): Promise<string[]> {
	const root = path.resolve(dir);
	mkdirSync(root, { recursive: true, mode: 0o755 });
	const members = await tarMembers(bytes);
	const files: string[] = [];
	let total = 0;
	for (const [entryPath, content] of members) {
		const parts = entryPath.split("/");
		if (entryPath.startsWith("/") || parts.some((s) => !pathSegment.test(s) || s === "." || s === ".."))
			throw new StageRefusedError("STALE_STAGE", `${entryPath}: not a normalized relative path`);
		const target = path.resolve(root, parts.join("/"));
		if (!target.startsWith(`${root}${path.sep}`))
			throw new StageRefusedError("STALE_STAGE", `${entryPath}: escapes the source root`);
		total += content.length;
		if (files.length + 1 > limits.maxFiles || content.length > limits.maxFileBytes || total > limits.maxTotalBytes)
			throw new StageRefusedError("STALE_STAGE", `${entryPath}: the source exceeds the limits`);
		mkdirSync(path.dirname(target), { recursive: true, mode: 0o755 });
		writeFileSync(target, content, { mode: 0o644 });
		files.push(parts.join("/"));
	}
	if (files.length === 0) throw new StageRefusedError("STALE_STAGE", "the source archive holds no file");
	return files.sort();
}
