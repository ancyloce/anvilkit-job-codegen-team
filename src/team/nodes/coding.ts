// The coding node (DD-03 §1): the one Pi source writer of the attempt, run
// as the candidate through the CodingExecutor, with the coder's whole
// remaining allowance for the round (nothing else sends while it writes).
// What the round left is data: the trusted side charges the coder's calls,
// and stops the run — without reviewers, validation, repair or a verdict
// about the candidate — when the round's last call was refused by Control
// or the sidecar, exceeded the allowance or the deadline before a send, or
// ended without an established outcome. A Control refusal is never sealed
// as a defect of the source the round did not finish.

import type { RoundResult } from "../../executor.js";
import { BudgetExhaustedError } from "../../port/model.js";
import type { NodeContext } from "../context.js";
import { repairUser } from "../roles.js";
import type { RoundSummary, TeamOutcome, TeamStateType } from "../state.js";

type Node = (state: TeamStateType) => Promise<Partial<TeamStateType>>;

export function codeNode(ctx: NodeContext): Node {
	const { deps, budget } = ctx;
	return async (state) => {
		ctx.guardDeadline("code");
		if (!state.plan) throw new Error("code: no plan");
		const isRepair = state.rounds.length > 0;
		const round = state.rounds.length + 1;
		const remaining = budget.remaining(state.budget, "coder");
		if (!budget.affords(remaining)) throw new BudgetExhaustedError("coder: no allowance left for a coding round");
		const revision = isRepair ? (BigInt(state.sourceRevision) + 1n).toString() : state.sourceRevision;
		let prompt: string;
		let continueFrom: RoundResult | undefined;
		if (isRepair) {
			const last = state.rounds[state.rounds.length - 1] as RoundSummary;
			continueFrom = deps.roundResults.get(last.round);
			const lastValidation = state.validations.filter((v) => v.round === last.round).at(-1)?.result;
			const findings = state.reviews.filter((r) => r.round === last.round).flatMap((r) => r.findings);
			const v =
				lastValidation && lastValidation.status !== "unavailable" && lastValidation.status !== "certified"
					? { failureCode: lastValidation.failureCode, detail: lastValidation.detail }
					: undefined;
			prompt = repairUser(findings, v, revision);
		} else {
			prompt = [
				`Implement source revision ${revision} exactly as planned.`,
				"Frozen brief (JSON):",
				JSON.stringify(state.brief, null, 2),
				"Plan (JSON):",
				JSON.stringify(state.plan, null, 2),
				state.retrieval?.status === "evidence"
					? `Retrieved conventions (cited): ${state.retrieval.answer}`
					: "No retrieved conventions were available; follow the plan and the source contract only.",
			].join("\n\n");
		}
		const result = await deps.executor.round({
			round,
			kind: isRepair ? "repair" : "code",
			prompt,
			sourceRevision: revision,
			continueFrom,
			remaining,
		});
		deps.roundResults.set(round, result);
		// The coder's calls are charged at the per-send exposure: from the
		// count the coder's own port left (its outcome — the identities asked
		// of the relay in the round, which bound its physical sends), else
		// from its transcript, else — when neither can be read — the whole
		// allowance the round was given. Control's ledger stays the authority.
		const counted = result.outcome?.calls ?? result.sessionUsage?.assistantMessages;
		const calls = counted ?? Math.min(deps.config.roles.coder.maxCalls, remaining.calls);
		const summary: RoundSummary = {
			round,
			kind: isRepair ? "repair" : "code",
			sourceRevision: revision,
			sealedDir: result.sealedDir,
			manifestDigest: result.source?.manifestDigest,
			files: result.source?.files.length,
			sourceError: result.sourceError,
			sessionDigest: result.sessionDigest,
			ended: result.outcome?.ended,
			failureCode: result.outcome?.failureCode,
			calls,
			stop: result.report.stop,
		};
		ctx.log("code", { round, kind: summary.kind, files: summary.files, ended: summary.ended, calls });
		const update: Partial<TeamStateType> = {
			rounds: [summary],
			sourceRevision: revision,
			repairs: isRepair ? 1 : 0,
			budget: budget.charge("coder", calls),
		};
		const stop = stoppingOutcome(result, round);
		if (stop) {
			update.outcome = stop;
			ctx.log("code", { round, outcome: stop.kind, failureCode: stop.failureCode });
		}
		return update;
	};
}

/**
 * The outcome that ends the run after a round, if any. An unknown outcome
 * (the round's own outcome or its transcript says so — either is data, and
 * either stops the run) fences everything until the original identity is
 * reconciled: a later run reenters the same identities and nothing here
 * replaces the call.
 */
export function stoppingOutcome(result: RoundResult, round: number): TeamOutcome | undefined {
	const o = result.outcome;
	const why = (o?.error ?? "").slice(0, 300);
	if (o?.failure === "uncertain" || o?.failureCode === "EFFECT_UNCERTAIN" || result.sessionUsage?.uncertain)
		return {
			kind: "effect_uncertain",
			failureCode: "EFFECT_UNCERTAIN",
			detail: `round ${round}: a coder call ended without an established outcome (${why || "transcript evidence"}); nothing continues until it is reconciled`,
			round,
		};
	switch (o?.failure) {
		case "refused":
			return {
				kind: "model_denied",
				failureCode: o.failureCode && /^[A-Z][A-Z0-9_]{0,63}$/.test(o.failureCode) ? o.failureCode : "MODEL_DENIED",
				detail: `round ${round}: a coder call was refused before any send (${why})`,
				round,
			};
		case "allowance":
			return { kind: "budget_exhausted", failureCode: "BUDGET_EXHAUSTED", detail: `round ${round}: ${why}`, round };
		case "deadline":
			return { kind: "deadline", failureCode: "DEADLINE_EXCEEDED", detail: `round ${round}: ${why}`, round };
		default:
			return undefined;
	}
}
