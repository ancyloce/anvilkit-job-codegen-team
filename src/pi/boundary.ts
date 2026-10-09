// The coder's file-operation boundary (DD-03 §3/§6): the SDK's own file
// tools — same names, descriptions and parameter schemas, so the reviewed
// tool digests are theirs — with every file operation proven to stay under
// the source directory, as a string and on disk (no link leads out, no
// glob pattern reaches out), on a new session, a reload and a tool rebuild.
// The SDK's grep runs ripgrep from the image's root-owned Pi agent
// directory, offline (environment.ts, pinned before the SDK loads).
import "./environment.js";
import { type Dirent, realpathSync } from "node:fs";
import { access, glob, mkdir, readdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import {
	createEditToolDefinition,
	createFindToolDefinition,
	createGrepToolDefinition,
	createLsToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
	type EditOperations,
	type FindOperations,
	type GrepOperations,
	type LsOperations,
	type ReadOperations,
	type ToolDefinition,
	type WriteOperations,
} from "@earendil-works/pi-coding-agent";

/** A Pi tool definition as the SDK's factories build it (the SDK's own ToolDefinition, any schema). */
// biome-ignore lint/suspicious/noExplicitAny: the SDK's ToolDefinition is generic over its TypeBox schema
export type Tool = ToolDefinition<any, any, any>;

/** The built-in Pi tools the coder may hold: file tools bound to its workspace; no shell. */
export const coderToolNames = ["read", "write", "edit", "ls", "grep", "find"] as const;
export type CoderToolName = (typeof coderToolNames)[number];

export class SourceBoundaryError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SourceBoundaryError";
	}
}

/**
 * The source boundary of the coder's tools (DD-03 §3): every path a tool
 * operates on, after the SDK resolved it against the session's cwd (`..`,
 * `~`, `@` and absolute paths included), must lie under the source root —
 * as a string, and on disk: an existing target, or the nearest existing
 * ancestor of one about to be created, must resolve (symbolic links
 * followed) to a location under the root, so no link inside the tree leads
 * a read or a write outside it. The root itself is trusted as given.
 */
export class SourceBoundary {
	readonly root: string;
	private realRoot: string | undefined;
	constructor(root: string) {
		this.root = path.resolve(root);
	}

	private under(candidate: string, root: string): boolean {
		return candidate === root || candidate.startsWith(`${root}${path.sep}`);
	}

	/** The absolute path, proven to be under the root; throws SourceBoundaryError otherwise. */
	async check(absolutePath: string, what: string): Promise<string> {
		const resolved = path.resolve(absolutePath);
		if (!this.under(resolved, this.root))
			throw new SourceBoundaryError(`${what}: ${absolutePath} is outside the source directory`);
		// On disk: the deepest existing prefix must resolve under the root too
		// (the root's own resolution is trusted: the trusted side created it).
		this.realRoot ??= await realpath(this.root);
		let probe = resolved;
		for (;;) {
			try {
				const real = await realpath(probe);
				if (!this.under(real, this.realRoot))
					throw new SourceBoundaryError(`${what}: ${absolutePath} leads outside the source directory`);
				return resolved;
			} catch (err) {
				if (err instanceof SourceBoundaryError) throw err;
				const parent = path.dirname(probe);
				if (parent === probe) throw new SourceBoundaryError(`${what}: ${absolutePath} cannot be resolved`);
				probe = parent;
			}
		}
	}

	read(): ReadOperations {
		return {
			readFile: async (p) => readFile(await this.check(p, "read")),
			access: async (p) => access(await this.check(p, "read")),
		};
	}

	write(): WriteOperations {
		return {
			writeFile: async (p, content) => writeFile(await this.check(p, "write"), content, "utf-8"),
			mkdir: async (dir) => {
				await mkdir(await this.check(dir, "write"), { recursive: true });
			},
		};
	}

	edit(): EditOperations {
		return {
			readFile: async (p) => readFile(await this.check(p, "edit")),
			writeFile: async (p, content) => writeFile(await this.check(p, "edit"), content, "utf-8"),
			access: async (p) => access(await this.check(p, "edit")),
		};
	}

	ls(): LsOperations {
		return {
			exists: async (p) => {
				await this.check(p, "ls");
				return access(p).then(
					() => true,
					() => false,
				);
			},
			stat: async (p) => stat(await this.check(p, "ls")),
			readdir: async (p) => readdir(await this.check(p, "ls")),
		};
	}

	grep(): GrepOperations {
		// The search itself is the SDK's (ripgrep over the checked directory,
		// without following links); the directory check runs before it starts.
		return {
			isDirectory: async (p) => (await stat(await this.check(p, "grep"))).isDirectory(),
			readFile: async (p) => readFile(await this.check(p, "grep"), "utf-8"),
		};
	}

	find(): FindOperations {
		return {
			exists: async (p) => {
				await this.check(p, "find");
				return access(p).then(
					() => true,
					() => false,
				);
			},
			glob: async (pattern, cwd, options) => {
				const searchRoot = await this.check(cwd, "find");
				// The pattern's scope is fixed before anything is read: Node's
				// glob would follow an absolute pattern, a `..` segment (also
				// one a brace hides) and a link named by a literal segment out
				// of the search directory. Its leading literal directories are
				// proven on disk like any other path; the refusal names no path.
				const refusal = () => new SourceBoundaryError("find: the pattern reaches outside the source directory");
				if (path.isAbsolute(pattern) || pattern.includes("..")) throw refusal();
				await this.check(path.resolve(searchRoot, ...literalPrefix(pattern)), "find").catch(() => {
					throw refusal();
				});
				// The traversal is fenced where Node consults us — the entries
				// under `**` and the directories it is about to enter — and every
				// match is validated by its real path (the matches of a trailing
				// magic segment are yielded without that consultation): what is
				// not in scope is neither entered nor answered.
				this.realRoot ??= await realpath(this.root);
				const realRoot = this.realRoot;
				const inScope = (absolute: string): boolean => {
					if (!this.under(absolute, this.root)) return false;
					const relative = path.relative(searchRoot, absolute);
					if (options.ignore.some((g) => path.matchesGlob(relative, g) || path.matchesGlob(`${relative}/`, g)))
						return false;
					try {
						return this.under(realpathSync(absolute), realRoot);
					} catch {
						return false;
					}
				};
				const absoluteOf = (entry: Dirent) => path.resolve(searchRoot, entry.parentPath, entry.name);
				const out: string[] = [];
				for await (const entry of glob(pattern, {
					cwd: searchRoot,
					withFileTypes: true,
					exclude: (entry) => !inScope(absoluteOf(entry)),
				})) {
					const absolute = absoluteOf(entry);
					if (!inScope(absolute)) continue;
					out.push(path.relative(searchRoot, absolute) || ".");
					if (out.length >= options.limit) break;
				}
				return out;
			},
		};
	}
}

/** The leading segments of a glob pattern before its first magic one (`*`, `?`, `[…]`, `{…}`, extglob `(…)`, an escape). */
function literalPrefix(pattern: string): string[] {
	const out: string[] = [];
	for (const segment of pattern.split("/")) {
		if (/[*?[\]{}()\\]/.test(segment)) break;
		out.push(segment);
	}
	return out;
}

/**
 * The coder's tool definitions: the SDK's own file tools (same names,
 * descriptions and parameter schemas, so the reviewed tool digests are
 * theirs), with their file operations replaced by the boundary's. They are
 * registered as the session's custom tools under the built-in names, which
 * the registry keeps through every rebuild (a reload, a tool re-selection):
 * a built-in rebuilt by name never replaces them.
 */
export function coderTools(sourceRoot: string, names: readonly CoderToolName[] = coderToolNames): Tool[] {
	const boundary = new SourceBoundary(sourceRoot);
	const cwd = boundary.root;
	const factories: Record<CoderToolName, () => Tool> = {
		read: () => createReadToolDefinition(cwd, { autoResizeImages: false, operations: boundary.read() }),
		write: () => createWriteToolDefinition(cwd, { operations: boundary.write() }),
		edit: () => createEditToolDefinition(cwd, { operations: boundary.edit() }),
		ls: () => createLsToolDefinition(cwd, { operations: boundary.ls() }),
		grep: () => createGrepToolDefinition(cwd, { operations: boundary.grep() }),
		find: () => createFindToolDefinition(cwd, { operations: boundary.find() }),
	};
	return names.map((n) => factories[n]());
}
