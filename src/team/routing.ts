// The team's bounded decisions (DD-03 §1, DD-04 §3): after a coding round,
// review it (within the review bound) or go straight to validation; after
// validation, return to the coder only for a repairable result of the
// independent validator with a sealed source and session to continue, the
// repair bound, the coder's allowance and the deadline all left; otherwise
// classify the run. Internal reviewers never start a repair on their own.
import { END, Send } from "@langchain/langgraph";
import type { TeamConfig } from "../config.js";
import type { NodeContext } from "./context.js";
import type { TeamOutcome, TeamStateType } from "./state.js";

export function afterCode(ctx: NodeContext) {
	return (state: TeamStateType): string => {
		if (state.outcome) return END; // the round ended the run (an unreconciled call, a refusal, a bound)
		const last = state.rounds[state.rounds.length - 1];
		if (!last?.manifestDigest) return "validate"; // nothing sealed to review; the validation records the seal error
		return state.reviewRounds < ctx.deps.config.reviews.max ? "review" : "validate";
	};
}

export const fanOut = (state: TeamStateType) => [
	new Send("code_reviewer", state),
	new Send("security_reviewer", state),
];

export function afterValidation(ctx: NodeContext) {
	const { deps, budget } = ctx;
	return (state: TeamStateType): string => {
		const last = state.rounds[state.rounds.length - 1];
		const v = state.validations.filter((x) => x.round === last?.round).at(-1)?.result;
		if (v?.status !== "repairable") return "seal";
		// A repair continues the sealed session over the sealed source; a round that left neither has nothing to repair from.
		const sealed = last ? deps.roundResults.get(last.round) : undefined;
		if (!sealed?.source || !sealed.sessionFile) return "seal";
		if (state.repairs >= deps.config.repairs.max) return "seal";
		if (!budget.affords(budget.remaining(state.budget, "coder"))) return "seal";
		if (ctx.pastDeadline()) return "seal";
		return "code";
	};
}

/** The classification node: the run's outcome from its final state. */
export function sealNode(ctx: NodeContext) {
	return async (state: TeamStateType): Promise<Partial<TeamStateType>> => ({
		outcome: classify(state, ctx.deps.config),
	});
}

/** The team outcome from the final state: the validator's word, the bounds that ended the run, or the last seal error. */
export function classify(state: TeamStateType, config: TeamConfig): TeamOutcome {
	const last = state.rounds[state.rounds.length - 1];
	const v = last ? state.validations.filter((x) => x.round === last.round).at(-1)?.result : undefined;
	if (!last) return { kind: "failed", detail: "no coding round ran" };
	if (!v) return { kind: "failed", detail: `round ${last.round} was not validated`, round: last.round };
	switch (v.status) {
		case "certified":
			return {
				kind: "certified",
				detail: `round ${last.round} certified by the independent validator`,
				round: last.round,
			};
		case "repairable": {
			const why =
				state.repairs >= config.repairs.max
					? `the repair bound (${config.repairs.max}) is reached`
					: "the allowance or the deadline leaves no repair round";
			return { kind: "repairable", failureCode: v.failureCode, detail: `${v.detail}; ${why}`, round: last.round };
		}
		case "invalid":
			return { kind: "invalid", failureCode: v.failureCode, detail: v.detail, round: last.round };
		case "infrastructure_failed":
			return { kind: "infrastructure_failed", failureCode: v.failureCode, detail: v.detail, round: last.round };
		case "unavailable":
			return { kind: "validation_unavailable", detail: v.reason, round: last.round };
	}
}
