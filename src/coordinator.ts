// anvilkit-codegen-team coordinator: the trusted coordinator of a codegen
// team attempt (DD-03 §1–§3, delivery.md P12-07). Started by the Go
// supervisor as UID 0 after the execution scope is granted, it prepares its
// inputs (coordinator/inputs.ts), asks Control's accepted stage first and
// proves a prior boundary (coordinator/recovery.ts), runs the bounded
// LangGraph team with the Pi coder as the candidate the supervisor launches
// for it (coordinator/run.ts), seals the joint stage through the sidecar's
// trusted routes (stage/), and leaves its account for the supervisor
// (coordinator/completion.ts). This entrypoint assembles them and handles
// the top-level errors: a canceled launch, a final refusal of the supervisor
// and a protocol violation end the run without a stage.
import { mkdirSync } from "node:fs";
import path from "node:path";
import { Completion } from "./coordinator/completion.js";
import { env, prepareInputs, required } from "./coordinator/inputs.js";
import { decideRecovery } from "./coordinator/recovery.js";
import { endsWithoutStage, RunCanceledError, runEvidence, runTeam } from "./coordinator/run.js";
import { StageStore } from "./stage/store.js";

function log(event: string, fields: Record<string, unknown> = {}): void {
	process.stderr.write(`${JSON.stringify({ at: new Date().toISOString(), event, ...fields })}\n`);
}

export async function main(): Promise<number> {
	const started = new Date();
	const verdictDir = required(env.verdict);
	const teamDir = path.join(verdictDir, "team");
	mkdirSync(teamDir, { recursive: true, mode: 0o700 });
	const completion = new Completion(teamDir, log);
	const abort = new AbortController();
	process.once("SIGTERM", () => {
		log("SIGTERM: stopping the team; nothing is sealed or submitted");
		abort.abort();
	});
	try {
		const inputs = await prepareInputs(verdictDir);
		const store = new StageStore({
			dir: path.join(teamDir, "stage"),
			sidecar: inputs.sidecar,
			identity: inputs.identity,
			teamProfileDigest: inputs.profileDigest,
			observerIdentity: inputs.observer,
			sourceLimits: inputs.config.source,
			log,
		});
		const recovery = await decideRecovery(inputs, store, log);
		if (recovery.kind === "accepted") {
			completion.accepted(recovery.proven);
			return completion.finish(0);
		}
		const run = await runTeam(inputs, recovery, abort.signal, log);
		completion.ran(run);
		// Writes have stopped: the graph returned, the port is idle, and every
		// candidate round was confirmed stopped by the supervisor. Seal.
		const sealed = await store.seal({
			saver: run.saver,
			threadId: inputs.scope.attemptId,
			checkpointId: run.checkpointId,
			state: run.state,
			outcome: run.outcome,
			roundResults: run.roundResults,
			ledger: run.port.ledger,
			evidence: runEvidence(inputs, run, started),
			signal: abort.signal,
		});
		run.saver.db.close();
		completion.sealed(sealed);
		return completion.finish(0);
	} catch (err) {
		completion.failed(abort.signal.aborted ? new RunCanceledError() : err);
		log("trusted flow did not complete", {
			error: completion.result.error,
			withoutStage: endsWithoutStage(err) || abort.signal.aborted,
		});
		return completion.finish(1);
	}
}

const invokedDirectly =
	process.argv[1] !== undefined && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);
if (invokedDirectly) {
	main().then(
		(code) => process.exit(code),
		(err) => {
			process.stderr.write(`coordinator: ${(err as Error).message}\n`);
			process.exit(1);
		},
	);
}
