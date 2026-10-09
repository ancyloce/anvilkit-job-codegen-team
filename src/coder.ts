// anvilkit-codegen-team coder: the one Pi source writer of an attempt
// (DD-03 §1/§6, delivery.md P12-03). It runs as the P09 candidate (UID
// 10001, launched by the Go supervisor through its privilege-drop
// trampoline, stopped and confirmed by it) with the round input the trusted
// coordinator wrote: the frozen plan and brief as its one turn, the exact
// source revision, the trusted system prompt, the file tools bound to the
// source directory, and the access sidecar's candidate socket as its only
// transport. It discovers nothing: no AGENTS.md, .pi, SYSTEM.md, extension,
// skill or settings file of the workspace is loaded, on a new session, a
// continued one or after compaction. Everything it writes is data for the
// trusted side; its exit code certifies nothing. Pi's tool environment is
// pinned before any Pi module loads (pi/environment.ts: offline, the
// image's root-owned agent directory), so the first import stays first.
import "./pi/environment.js";
import { copyFileSync, cpSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { SidecarClient } from "./adapters/sidecar.js";
import { type Allowance, moneyAmount } from "./budget.js";
import { type CoderToolName, coderTools } from "./pi/boundary.js";
import { createCoderSession } from "./pi/session.js";
import {
	BudgetExhaustedError,
	ControlledModelPort,
	DeadlineExceededError,
	EffectUncertainError,
	ModelCallFailedError,
	ModelCallRefusedError,
} from "./port/model.js";
import { controlledModel, createControlledStreamFn } from "./port/pi.js";
import { type CallFailure, parseRoundInput, type RoundInput, type RoundOutcome } from "./round.js";
import { assertRealBelow } from "./source.js";

export const roundDirEnv = "ANVILKIT_ROUND_DIR";
export const roundInputFile = "round.json";
export const roundOutcomeFile = "outcome.json";

/** Runs one round; returns the outcome written for the trusted side. */
export async function runRound(input: RoundInput, outcomeDir: string): Promise<RoundOutcome> {
	// A repair launch's first round repairs the prior attempt's proven
	// source: the trusted prior tree is read-only to this identity, so the
	// round's source directory is replaced by this identity's own copy of it
	// (regular files and directories only, as the trusted side unpacked
	// them) before anything is written.
	if (input.priorSource) {
		rmSync(input.sourceDir, { recursive: true, force: true });
		cpSync(input.priorSource, input.sourceDir, {
			recursive: true,
			errorOnExist: true,
			force: false,
			verbatimSymlinks: true,
			filter: (src) => {
				const st = lstatSync(src);
				return st.isDirectory() || st.isFile();
			},
		});
	}
	mkdirSync(input.sourceDir, { recursive: true });
	mkdirSync(input.sessionDir, { recursive: true });
	// The tools are bound to the source directory as a real directory under
	// the workspace: a link planted at it or on the way (by anything else that
	// ran under this identity) would carry the model's reads and writes
	// elsewhere, and the trusted seal would refuse the round anyway.
	assertRealBelow(input.workspace, input.sourceDir, "source directory");
	assertRealBelow(input.workspace, input.sessionDir, "session directory");
	const client = new SidecarClient(input.socket);
	const deadline = new Date(input.deadline);
	const port = new ControlledModelPort({
		relay: (req, o) => client.relay(req, o),
		routeId: input.routeId,
		deadline,
		callIdPrefix: `${input.callIdPrefix}:r${input.round}`,
		maxConcurrent: 1,
		deadlineMarginMs: 5_000,
	});
	// The ordinal names the next call; the allowance is what the port's
	// ledger shows spent (every call identity asked of the relay, once —
	// a reentry, a replay or a reconciliation of the same identity is not a
	// second charge). Taking an ordinal spends nothing, so the round's one
	// allowed call is admitted under ordinal 1 and the second is refused
	// before a send.
	let ordinal = 0;
	let failure: Error | undefined;
	const remaining = (): Allowance => {
		const spent = port.spent("coder");
		return {
			calls: input.limits.maxCalls - spent.calls,
			exposure: {
				currency: input.limits.exposure.currency,
				amount: (moneyAmount(input.limits.exposure) - spent.exposure).toString(),
			},
			aggregateCalls: input.limits.aggregateCalls - spent.calls,
			aggregateExposure: {
				currency: input.limits.aggregateExposure.currency,
				amount: (moneyAmount(input.limits.aggregateExposure) - spent.exposure).toString(),
			},
		};
	};
	const streamFn = createControlledStreamFn({
		port,
		role: "coder",
		maxOutputTokens: input.limits.maxOutputTokens,
		exposure: input.limits.exposurePerSend,
		remaining,
		nextOrdinal: () => ++ordinal,
		onFailure: (err) => {
			failure = err;
		},
	});
	// A continued session is the sealed copy of the previous round, taken
	// into this round's own session directory (the sealed copy is root-owned).
	let session: { file: string } | { dir: string } = { dir: input.sessionDir };
	if (input.continueSession) {
		const own = path.join(input.sessionDir, `round-${input.round}.jsonl`);
		copyFileSync(input.continueSession, own);
		session = { file: own };
	}
	const agentSession = await createCoderSession({
		cwd: input.sourceDir,
		systemPrompt: input.systemPrompt,
		model: controlledModel(input.routeId, input.model.contextWindow, input.model.maxTokens),
		streamFn,
		tools: coderTools(input.sourceDir, input.tools as CoderToolName[]),
		session,
		compaction: input.compaction,
	});
	const outcome: RoundOutcome = {
		schemaVersion: 1,
		round: input.round,
		sessionFile: agentSession.sessionFile ?? "",
		calls: 0,
		ended: "completed",
	};
	try {
		await agentSession.prompt(input.prompt);
		if (failure) {
			outcome.ended = "call_failed";
			outcome.error = failure.message.slice(0, 4096);
			const code = (failure as { code?: string }).code;
			if (code) outcome.failureCode = code.slice(0, 64);
			outcome.failure = callFailure(failure);
		}
	} catch (err) {
		outcome.ended = "error";
		outcome.error = (err as Error).message.slice(0, 4096);
	} finally {
		agentSession.dispose();
	}
	outcome.calls = port.spent("coder").calls;
	mkdirSync(outcomeDir, { recursive: true });
	writeFileSync(path.join(outcomeDir, roundOutcomeFile), JSON.stringify(outcome));
	return outcome;
}

/** How the call that ended the round failed, from the port's error classes (data for the trusted side, which only stops on it). */
export function callFailure(err: Error): CallFailure {
	if (err instanceof ModelCallRefusedError) return "refused";
	if (err instanceof BudgetExhaustedError) return "allowance";
	if (err instanceof DeadlineExceededError) return "deadline";
	if (err instanceof EffectUncertainError) return "uncertain";
	if (err instanceof ModelCallFailedError && err.outcome === "canceled") return "canceled";
	return "failed";
}

async function main(): Promise<number> {
	const roundDir = process.env[roundDirEnv];
	if (!roundDir) {
		process.stderr.write(`coder: ${roundDirEnv} is required\n`);
		return 2;
	}
	const input = parseRoundInput(readFileSync(path.join(roundDir, roundInputFile), "utf8"));
	const outcome = await runRound(input, path.join(input.sessionDir, "..", "rounds", String(input.round)));
	process.stdout.write(`coder: round ${input.round} ${outcome.ended} after ${outcome.calls} call(s)\n`);
	return outcome.ended === "completed" ? 0 : 1;
}

const invokedDirectly =
	process.argv[1] !== undefined && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);
if (invokedDirectly) {
	main().then(
		(code) => process.exit(code),
		(err) => {
			process.stderr.write(`coder: ${(err as Error).message}\n`);
			process.exit(1);
		},
	);
}
