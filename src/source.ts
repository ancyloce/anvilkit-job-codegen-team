// The sealed source (DD-03 §3, DD-04 §1): the trusted side reads the Pi
// coder's source directory itself — regular files only, no links, no
// special files, no case aliases, bounded — copies the bytes into an
// immutable root-owned copy and computes the inventory and the manifest
// digest with the validator's algorithm (sorted normalized paths and actual
// bytes, boundary-bound), so the digest the codegen stage binds is the one
// the independent Validator computes for the same bytes. The complete-source
// contract itself (declaration, package, lockfile, dependencies within the
// build-support profile) is the Validator's check, never repeated here.
import { createHash } from "node:crypto";
import { type Dirent, lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { type Digest, sequence, sha256 } from "./digest.js";

export interface SourceLimits {
	maxFiles: number;
	maxFileBytes: number;
	maxTotalBytes: number;
}

export interface SourceFile {
	path: string;
	digest: Digest;
	sizeBytes: string;
}

export interface SealedSource {
	files: SourceFile[];
	totalBytes: number;
	/** The validator's manifest digest of the same bytes. */
	manifestDigest: Digest;
}

export class SourceSealError extends Error {
	constructor(
		readonly code: "PATH_ESCAPE" | "CANDIDATE_BUILD_FAILED",
		message: string,
	) {
		super(message);
		this.name = "SourceSealError";
	}
}

const segmentPattern = /^\.?[A-Za-z0-9_@-][A-Za-z0-9._@-]*$/;
const maxDepth = 16;
const maxPathLength = 512;

/** sha256 over length-prefixed parts (the validator's sha256Parts). */
export function sha256Parts(parts: Array<Uint8Array | string>): Digest {
	const h = createHash("sha256");
	for (const p of parts) {
		const b = typeof p === "string" ? Buffer.from(p, "utf8") : p;
		h.update(`${b.byteLength}\0`);
		h.update(b);
	}
	return `sha256:${h.digest("hex")}`;
}

/** The manifest digest: the sorted normalized paths and the actual bytes, boundary-bound. */
export function manifestDigest(files: Map<string, Buffer>): Digest {
	const parts: Array<Uint8Array | string> = [];
	for (const p of [...files.keys()].sort()) {
		parts.push(p);
		parts.push(files.get(p) as Buffer);
	}
	return sha256Parts(parts);
}

/**
 * Refuses a symbolic link anywhere between a trusted base and a target the
 * candidate controls: every component of the path below the base must be a
 * real directory (the last one a directory or a regular file). The seal
 * runs with the trusted side's privileges, so a link at the source root, at
 * the session directory or on the way to either would let it copy content
 * from outside the candidate's tree into the sealed artifacts.
 */
export function assertRealBelow(base: string, target: string, what: string): void {
	const rel = path.relative(path.resolve(base), path.resolve(target));
	if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel))
		throw new SourceSealError("PATH_ESCAPE", `${what}: ${target} is not below ${base}`);
	let cur = path.resolve(base);
	const parts = rel.split(path.sep);
	parts.forEach((part, i) => {
		cur = path.join(cur, part);
		let st: ReturnType<typeof lstatSync>;
		try {
			st = lstatSync(cur);
		} catch (err) {
			throw new SourceSealError("CANDIDATE_BUILD_FAILED", `${what}: ${cur}: ${(err as Error).message}`);
		}
		if (st.isSymbolicLink()) throw new SourceSealError("PATH_ESCAPE", `${what}: ${cur} is a symbolic link`);
		if (i < parts.length - 1 && !st.isDirectory())
			throw new SourceSealError("PATH_ESCAPE", `${what}: ${cur} is not a directory`);
		if (i === parts.length - 1 && !st.isDirectory() && !st.isFile())
			throw new SourceSealError("PATH_ESCAPE", `${what}: ${cur} is not a directory or a regular file`);
	});
}

/**
 * Reads a source tree as the seal sees it: the map of normalized relative
 * paths to bytes. The root itself must be a real directory, and, when the
 * trusted base it lies under is given, so must everything between them.
 */
export function readTree(root: string, limits: SourceLimits, base?: string): Map<string, Buffer> {
	if (base !== undefined) assertRealBelow(base, root, "source root");
	let rootStat: ReturnType<typeof lstatSync>;
	try {
		rootStat = lstatSync(root);
	} catch (err) {
		throw new SourceSealError("CANDIDATE_BUILD_FAILED", `source root: ${(err as Error).message}`);
	}
	if (rootStat.isSymbolicLink()) throw new SourceSealError("PATH_ESCAPE", "source root: a symbolic link is refused");
	if (!rootStat.isDirectory()) throw new SourceSealError("CANDIDATE_BUILD_FAILED", "source root: not a directory");
	const files = new Map<string, Buffer>();
	const folded = new Map<string, string>();
	let total = 0;
	const visit = (dir: string, rel: string[]): void => {
		if (rel.length > maxDepth)
			throw new SourceSealError("PATH_ESCAPE", `${rel.join("/")}: deeper than ${maxDepth} segments`);
		let entries: Dirent[];
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch (err) {
			throw new SourceSealError("CANDIDATE_BUILD_FAILED", `${rel.join("/") || "."}: ${(err as Error).message}`);
		}
		for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
			const name = entry.name;
			const relPath = [...rel, name].join("/");
			if (name.includes("/") || name.includes("\\") || name.includes("\0") || !segmentPattern.test(name))
				throw new SourceSealError("PATH_ESCAPE", `${relPath}: segment is not a normalized relative path segment`);
			if (relPath.length > maxPathLength)
				throw new SourceSealError("PATH_ESCAPE", `${relPath}: longer than ${maxPathLength}`);
			const key = relPath.normalize("NFKC").toLowerCase();
			const other = folded.get(key);
			if (other !== undefined && other !== relPath)
				throw new SourceSealError("PATH_ESCAPE", `${relPath} and ${other} are case aliases of one path`);
			folded.set(key, relPath);
			const abs = path.join(dir, name);
			const st = lstatSync(abs);
			if (st.isSymbolicLink()) throw new SourceSealError("PATH_ESCAPE", `${relPath}: symbolic links are refused`);
			if (st.isDirectory()) {
				visit(abs, [...rel, name]);
				continue;
			}
			if (!st.isFile()) throw new SourceSealError("PATH_ESCAPE", `${relPath}: not a regular file`);
			if (st.nlink > 1) throw new SourceSealError("PATH_ESCAPE", `${relPath}: hard links are refused`);
			if (st.size > limits.maxFileBytes)
				throw new SourceSealError(
					"CANDIDATE_BUILD_FAILED",
					`${relPath}: ${st.size} bytes exceed the ${limits.maxFileBytes}-byte file bound`,
				);
			total += st.size;
			if (total > limits.maxTotalBytes)
				throw new SourceSealError(
					"CANDIDATE_BUILD_FAILED",
					`the source exceeds the ${limits.maxTotalBytes}-byte bound`,
				);
			if (files.size + 1 > limits.maxFiles)
				throw new SourceSealError("CANDIDATE_BUILD_FAILED", `the source exceeds the ${limits.maxFiles}-file bound`);
			// Read by the path lstat described; a swap between lstat and read
			// can only replace a regular file by another regular file's bytes
			// of the same owner (the candidate cannot create links here after
			// its process is stopped and confirmed gone).
			const bytes = readFileSync(abs);
			if (bytes.length !== st.size)
				throw new SourceSealError("CANDIDATE_BUILD_FAILED", `${relPath}: size changed while sealing`);
			files.set(relPath, bytes);
		}
	};
	visit(root, []);
	return files;
}

/** Copies a tree read by readTree into an immutable copy (root-owned, 0500 directories, 0400 files). */
export function writeTree(dest: string, files: Map<string, Buffer>): void {
	mkdirSync(dest, { recursive: true, mode: 0o700 });
	for (const p of [...files.keys()].sort()) {
		const abs = path.join(dest, p);
		mkdirSync(path.dirname(abs), { recursive: true, mode: 0o700 });
		writeFileSync(abs, files.get(p) as Buffer, { mode: 0o400, flag: "wx" });
	}
}

/** The inventory of a tree as the manifest records it. */
export function inventory(files: Map<string, Buffer>): SealedSource {
	const out: SourceFile[] = [];
	let total = 0;
	for (const p of [...files.keys()].sort()) {
		const b = files.get(p) as Buffer;
		total += b.length;
		out.push({ path: p, digest: sha256(b), sizeBytes: sequence(b.length) });
	}
	return { files: out, totalBytes: total, manifestDigest: manifestDigest(files) };
}

/** Seals the candidate's source directory into dest and returns its inventory (base: the trusted directory it lies under). */
export function sealSource(sourceDir: string, dest: string, limits: SourceLimits, base?: string): SealedSource {
	const files = readTree(sourceDir, limits, base);
	if (files.size === 0) throw new SourceSealError("CANDIDATE_BUILD_FAILED", "the source is empty");
	writeTree(dest, files);
	return inventory(files);
}

/** Recomputes the inventory of a sealed copy and compares it with a recorded one. */
export function verifySealed(
	dir: string,
	expected: SealedSource,
	limits: SourceLimits,
	base?: string,
): string | undefined {
	let files: Map<string, Buffer>;
	try {
		files = readTree(dir, limits, base);
	} catch (err) {
		return (err as Error).message;
	}
	const got = inventory(files);
	if (got.manifestDigest !== expected.manifestDigest)
		return `manifest digest ${got.manifestDigest} differs from ${expected.manifestDigest}`;
	if (got.files.length !== expected.files.length) return "file count differs";
	return undefined;
}
