// CodingExecutor (DD-03 §1/§2, delivery.md P12-03): the trusted side of a
// coding round. It writes the round input the Pi coder is bound to, asks
// the supervisor to run the candidate (the Go supervisor launches it through
// the privilege-drop trampoline and confirms it is gone before this side
// reads anything), then seals what the coder left: the source directory as
// an immutable root-owned copy with its inventory and manifest digest, and
// the session transcript with its digest. One round runs at a time — the Pi
// coder is the only source writer of the attempt and two of it never exist —
// and a continued round starts from the sealed session and the sealed source
// of the round before it, never from a mixed pair.
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Allowance } from "./budget.js";
import { roundInputFile, roundOutcomeFile } from "./coder.js";
import { type Digest, sha256 } from "./digest.js";
import { finalRefusals } from "./protocol.js";
import { parseRoundOutcome, type RoundInput, type RoundLimits, type RoundOutcome } from "./round.js";
import {
	assertRealBelow,
	type SealedSource,
	type SourceLimits,
	SourceSealError,
	sealSource,
	verifySealed,
} from "./source.js";

export interface CandidateRunRequest {
	round: number;
	roundDir: string;
}

/** How the candidate's execution ended, as the supervisor established it. */
export interface CandidateRunReport {
	exit: number | null;
	signal?: string;
	stop: "exited" | "timeout" | "canceled";
	descendantsStopped: number;
	startedAt: string;
	endedAt: string;
}

/** Runs the Pi coder as the candidate: the Go supervisor over its protocol (adapters/supervisor.ts), or a test runner. */
export interface CandidateRunner {
	run(req: CandidateRunRequest, signal?: AbortSignal): Promise<CandidateRunReport>;
}

/**
 * The supervisor refused a round. A final refusal (the candidate could not
 * run, or its stop could not be established) ends the attempt: no later
 * round runs and nothing is sealed or submitted, because nothing proves
 * that no candidate still writes.
 */
export class CandidateRoundRefusedError extends Error {
	constructor(
		readonly code: string,
		readonly reason: string,
		readonly final: boolean,
	) {
		super(`the supervisor refused the candidate round: ${code} ${reason}`);
		this.name = "CandidateRoundRefusedError";
	}
}

export function refusedRound(code: string, reason: string): CandidateRoundRefusedError {
	return new CandidateRoundRefusedError(code, reason, finalRefusals.has(code));
}

export interface ExecutorConfig {
	/** The workspace root: round inputs under <workspace>/round/<n>, the candidate's own tree under <workspace>/w. */
	workspace: string;
	/** Where sealed rounds go (inside the verdict tree). */
	sealDir: string;
	candidateSocket: string;
	routeId: string;
	callIdPrefix: string;
	model: { contextWindow: number; maxTokens: number };
	compaction: { enabled: boolean; reserveTokens: number; keepRecentTokens: number };
	tools: string[];
	systemPrompt: string;
	deadline: Date;
	/** The coder's reviewed per-call limits; its allowance comes with every round. */
	limits: Pick<RoundLimits, "maxCalls" | "maxOutputTokens" | "exposurePerSend">;
	sourceLimits: SourceLimits;
	maxSessionBytes: number;
}

export interface RoundSpec {
	round: number;
	kind: "code" | "repair";
	prompt: string;
	sourceRevision: string;
	continueFrom?: RoundResult;
	remaining: Allowance;
}

export interface SessionUsage {
	assistantMessages: number;
	inputUnits: number;
	outputUnits: number;
	errors: number;
	/** An assistant message of the transcript ended with an unreconciled call (EFFECT_UNCERTAIN). */
	uncertain: boolean;
}

export interface RoundResult {
	round: number;
	kind: "code" | "repair";
	sourceRevision: string;
	sealedDir: string;
	source?: SealedSource;
	sourceError?: { code: SourceSealError["code"]; message: string };
	/** Why the claimed session was not sealed (a link on the way to it, or a path outside the session directory). */
	sessionError?: { code: SourceSealError["code"]; message: string };
	sessionFile?: string;
	sessionDigest?: Digest;
	sessionUsage?: SessionUsage;
	outcome?: RoundOutcome;
	report: CandidateRunReport;
}

export class SourceWriterConflictError extends Error {
	constructor() {
		super("a source writer is already running for this attempt; one Pi coder per attempt");
		this.name = "SourceWriterConflictError";
	}
}

export class CodingExecutor {
	private inFlight = false;
	readonly rounds: RoundResult[] = [];

	constructor(
		private readonly config: ExecutorConfig,
		private readonly runner: CandidateRunner,
	) {}

	get candidateTree(): string {
		return path.join(this.config.workspace, "w");
	}

	roundDir(round: number): string {
		return path.join(this.config.workspace, "round", String(round));
	}

	private roundInput(spec: RoundSpec, continueSession: string | undefined): RoundInput {
		const c = this.config;
		const input: RoundInput = {
			schemaVersion: 1,
			round: spec.round,
			kind: spec.kind,
			callIdPrefix: c.callIdPrefix,
			routeId: c.routeId,
			model: c.model,
			limits: {
				maxCalls: Math.min(c.limits.maxCalls, spec.remaining.calls),
				maxOutputTokens: c.limits.maxOutputTokens,
				exposurePerSend: c.limits.exposurePerSend,
				exposure: spec.remaining.exposure,
				aggregateCalls: spec.remaining.aggregateCalls,
				aggregateExposure: spec.remaining.aggregateExposure,
			},
			deadline: c.deadline.toISOString(),
			compaction: c.compaction,
			systemPrompt: c.systemPrompt,
			tools: c.tools,
			prompt: spec.prompt,
			sourceRevision: spec.sourceRevision,
			workspace: c.workspace,
			sourceDir: path.join(this.candidateTree, "source"),
			sessionDir: path.join(this.candidateTree, "session"),
			socket: c.candidateSocket,
		};
		if (continueSession) input.continueSession = continueSession;
		return input;
	}

	async round(spec: RoundSpec, signal?: AbortSignal): Promise<RoundResult> {
		if (this.inFlight) throw new SourceWriterConflictError();
		if (this.rounds.some((r) => r.round === spec.round)) throw new Error(`round ${spec.round} already ran`);
		if (spec.remaining.calls < 1) throw new Error(`round ${spec.round}: no coder call left in the allowance`);
		this.inFlight = true;
		try {
			// The round tree is the trusted side's (the supervisor refuses a
			// round directory that is not a real directory of this identity).
			trustedDir(path.join(this.config.workspace, "round"));
			const roundDir = this.roundDir(spec.round);
			trustedDir(roundDir);
			let continueSession: string | undefined;
			if (spec.continueFrom) {
				const prev = spec.continueFrom;
				if (!prev.source || !prev.sessionFile)
					throw new Error(`round ${spec.round}: the round before it sealed no source and session to continue from`);
				// The candidate's source tree must still be the sealed source
				// of the round before; a divergence means another writer
				// touched it, and the round does not start.
				const drift = verifySealed(
					path.join(this.candidateTree, "source"),
					prev.source,
					this.config.sourceLimits,
					this.config.workspace,
				);
				if (drift)
					throw new Error(
						`round ${spec.round}: the workspace source is not the sealed source of round ${prev.round}: ${drift}`,
					);
				// The sealed copy is root-only; the candidate reads its own copy in the round directory.
				const copy = path.join(roundDir, "session.jsonl");
				writeFileSync(copy, readFileSync(prev.sessionFile), { mode: 0o644 });
				continueSession = copy;
			}
			const input = this.roundInput(spec, continueSession);
			writeFileSync(path.join(roundDir, roundInputFile), JSON.stringify(input), { mode: 0o644 });
			const report = await this.runner.run({ round: spec.round, roundDir }, signal);
			const result = this.seal(spec, report);
			this.rounds.push(result);
			return result;
		} finally {
			this.inFlight = false;
		}
	}

	/** Seals the round from what the stopped candidate left; nothing here trusts the coder's word. */
	private seal(spec: RoundSpec, report: CandidateRunReport): RoundResult {
		const sealedDir = path.join(this.config.sealDir, String(spec.round));
		mkdirSync(sealedDir, { recursive: true, mode: 0o700 });
		const result: RoundResult = {
			round: spec.round,
			kind: spec.kind,
			sourceRevision: spec.sourceRevision,
			sealedDir,
			report,
		};
		// Everything read from the candidate's tree is reached through real
		// directories only (assertRealBelow from the trusted workspace root): a
		// link at the tree, the source root, the session directory or on the way
		// to a file would let this root-privileged seal copy outside content.
		const workspace = this.config.workspace;
		const outcomePath = path.join(this.candidateTree, "rounds", String(spec.round), roundOutcomeFile);
		if (existsSync(outcomePath)) {
			try {
				assertRealBelow(workspace, outcomePath, "round outcome");
				const st = lstatSync(outcomePath);
				if (st.isFile() && st.size <= 64 << 10) result.outcome = parseRoundOutcome(readFileSync(outcomePath, "utf8"));
			} catch {
				// a malformed or unreachable outcome is data the coder did not leave in the reviewed shape; the seal continues from the bytes
			}
		}
		try {
			result.source = sealSource(
				path.join(this.candidateTree, "source"),
				path.join(sealedDir, "source"),
				this.config.sourceLimits,
				workspace,
			);
		} catch (err) {
			if (err instanceof SourceSealError) result.sourceError = { code: err.code, message: err.message };
			else throw err;
		}
		const sessionDir = path.join(this.candidateTree, "session");
		const claimed = result.outcome?.sessionFile;
		if (claimed) {
			const resolved = path.resolve(claimed);
			const inside = resolved.startsWith(`${path.resolve(sessionDir)}${path.sep}`);
			let real = false;
			try {
				assertRealBelow(workspace, resolved, "session");
				real = true;
			} catch (err) {
				if (err instanceof SourceSealError) result.sessionError = { code: err.code, message: err.message };
				else throw err;
			}
			if (inside && real && existsSync(resolved)) {
				const st = lstatSync(resolved);
				if (st.isFile() && st.size <= this.config.maxSessionBytes) {
					const bytes = readFileSync(resolved);
					const sealed = path.join(sealedDir, "session.jsonl");
					writeFileSync(sealed, bytes, { mode: 0o400, flag: "wx" });
					result.sessionFile = sealed;
					result.sessionDigest = sha256(bytes);
					result.sessionUsage = sessionUsage(bytes.toString("utf8"));
				}
			}
		}
		writeFileSync(
			path.join(sealedDir, "round.json"),
			JSON.stringify({ ...result, sessionFile: result.sessionFile && path.basename(result.sessionFile) }),
			{ mode: 0o400, flag: "wx" },
		);
		return result;
	}
}

/**
 * Creates (when absent) and proves a directory of the trusted side under the
 * candidate-writable workspace: a real directory of this process's identity
 * that neither group nor others can write. It runs before any candidate
 * round, so the candidate cannot plant the name; a planted or altered one
 * refuses the round.
 */
export function trustedDir(dir: string): void {
	try {
		mkdirSync(dir, { mode: 0o755 });
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
	}
	const st = lstatSync(dir);
	const uid = process.geteuid?.() ?? st.uid;
	if (!st.isDirectory() || st.uid !== uid || (st.mode & 0o022) !== 0)
		throw new Error(`${dir} is not a real directory of the trusted identity closed to group and other writes`);
}

/** The usage the session transcript reports for its assistant messages (evidence, not the ledger). */
export function sessionUsage(text: string): SessionUsage {
	const usage: SessionUsage = { assistantMessages: 0, inputUnits: 0, outputUnits: 0, errors: 0, uncertain: false };
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		let entry: {
			type?: string;
			message?: {
				role?: string;
				usage?: { input?: number; output?: number };
				stopReason?: string;
				errorMessage?: string;
			};
		};
		try {
			entry = JSON.parse(line);
		} catch {
			continue;
		}
		if (entry.type !== "message" || entry.message?.role !== "assistant") continue;
		usage.assistantMessages++;
		usage.inputUnits += entry.message.usage?.input ?? 0;
		usage.outputUnits += entry.message.usage?.output ?? 0;
		if (entry.message.stopReason === "error" || entry.message.stopReason === "aborted") usage.errors++;
		if (entry.message.stopReason === "error" && (entry.message.errorMessage ?? "").includes("EFFECT_UNCERTAIN"))
			usage.uncertain = true;
	}
	return usage;
}
