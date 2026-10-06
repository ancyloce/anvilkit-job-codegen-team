// The coordinator's completion (the process protocol's teamResult): its own
// account of the run in the verdict tree (team/result.json), written once
// before it exits — controlled identities, classes and counts only, the
// verdict consistent with the outcome whatever ended the run, and checked
// against the protocol contract before it is written. Prompts, source,
// transcripts and model bodies never reach it, nor stderr.
import { writeFileSync } from "node:fs";
import path from "node:path";
import { CandidateRoundRefusedError } from "../executor.js";
import { encodeResult, protocolVersion, type TeamResult } from "../protocol.js";
import { StageRefusedError, verdictFor } from "../stage/manifest.js";
import type { ProvenStage } from "../stage/proof.js";
import type { SealedStage } from "../stage/seal.js";
import type { TeamOutcome } from "../team/state.js";
import { outcomeOfError, RunCanceledError, type TeamRun } from "./run.js";

const codePattern = /^[A-Z][A-Z0-9_]{0,63}$/;

export class Completion {
	readonly result: TeamResult = {
		protocolVersion,
		outcome: { kind: "failed", detail: "not started" },
		verdict: "infrastructure_failed",
		failureCode: "OBSERVER_FAILED",
	};

	constructor(
		private readonly teamDir: string,
		private readonly log: (event: string, fields?: Record<string, unknown>) => void,
	) {}

	private setOutcome(outcome: TeamOutcome, verdict?: { verdict: TeamResult["verdict"]; failureCode: string }): void {
		const o: TeamResult["outcome"] = { kind: outcome.kind, detail: outcome.detail.slice(0, 1000) };
		if (outcome.failureCode && codePattern.test(outcome.failureCode)) o.failureCode = outcome.failureCode;
		if (outcome.round !== undefined) o.round = outcome.round;
		this.result.outcome = o;
		const v = verdict ?? verdictFor(outcome);
		this.result.verdict = v.verdict;
		this.result.failureCode = v.failureCode;
	}

	/** Control already accepted this attempt's stage, proven against the local objects. */
	accepted(proven: ProvenStage): void {
		const rm = proven.resultManifest as { verdict: TeamResult["verdict"]; failureCode?: string };
		this.setOutcome(proven.manifest.outcome, { verdict: rm.verdict, failureCode: rm.failureCode ?? "" });
		this.result.stageId = proven.accepted.stageId;
		this.result.existing = true;
		this.result.counters = proven.manifest.counters;
		this.log("proven accepted boundary; nothing to do", { stageId: proven.accepted.stageId });
	}

	/** The run's outcome, counters and calls (every controlled call of the attempt as the state accounted it). */
	ran(run: TeamRun): void {
		this.setOutcome(run.outcome);
		const s = run.state;
		this.result.counters = { rounds: s.rounds.length, reviewRounds: s.reviewRounds, repairs: s.repairs };
		this.result.calls = s.budget.total.calls;
	}

	sealed(stage: SealedStage): void {
		this.result.stageId = stage.stageId;
		this.result.existing = stage.existing;
	}

	/** A run that ended by an error: the verdict follows the class, never a candidate verdict. */
	failed(err: unknown): void {
		const e = err as Error;
		const detail = (e?.message ?? String(err)).slice(0, 1000);
		if (err instanceof RunCanceledError || (err instanceof StageRefusedError && err.code === "CANCELED")) {
			this.setOutcome({ kind: "canceled", detail });
		} else if (err instanceof CandidateRoundRefusedError) {
			this.setOutcome({ kind: "infrastructure_failed", failureCode: err.code, detail });
			this.result.failureCode = "OBSERVER_FAILED";
		} else if (err instanceof StageRefusedError) {
			this.setOutcome(
				{ kind: "failed", failureCode: err.code, detail },
				{ verdict: "infrastructure_failed", failureCode: err.code === "STALE_STAGE" ? "OBSERVER_FAILED" : err.code },
			);
		} else {
			this.setOutcome(outcomeOfError(err));
			if (this.result.verdict !== "canceled") this.result.verdict = "infrastructure_failed";
		}
		if (!codePattern.test(this.result.failureCode)) this.result.failureCode = "OBSERVER_FAILED";
		delete this.result.stageId;
		delete this.result.existing;
		this.result.error = detail;
	}

	/** Writes the result document and returns the exit code. */
	finish(code: number): number {
		let text: string;
		try {
			text = encodeResult(this.result);
		} catch (err) {
			// A defect of this package (or a contract copy that cannot be read)
			// must not leave the supervisor without an account: the run is
			// reported failed in the protocol's fixed minimal form.
			text = JSON.stringify({
				protocolVersion,
				outcome: { kind: "failed", detail: "the coordinator's result did not satisfy the protocol" },
				verdict: "infrastructure_failed",
				failureCode: "OBSERVER_FAILED",
				error: (err as Error).message.slice(0, 1000),
			});
			code = 1;
		}
		writeFileSync(path.join(this.teamDir, "result.json"), text, { mode: 0o600 });
		this.log("coordinator finished", {
			outcome: this.result.outcome.kind,
			verdict: this.result.verdict,
			failureCode: this.result.failureCode,
			stageId: this.result.stageId,
			exit: code,
		});
		return code;
	}
}
