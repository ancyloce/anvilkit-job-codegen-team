// The validation node (DD-04 §3): the sealed source of the last round goes
// to the independent validation port; a round that sealed no source is
// classified from its seal error (a path escape is invalid, anything else
// repairable) without asking the validator.
import type { ValidationResult } from "../../validation.js";
import type { NodeContext } from "../context.js";
import type { TeamStateType } from "../state.js";

export function validateNode(ctx: NodeContext): (state: TeamStateType) => Promise<Partial<TeamStateType>> {
	const { deps } = ctx;
	return async (state) => {
		ctx.guardDeadline("validate");
		const last = state.rounds[state.rounds.length - 1];
		if (!last) throw new Error("validate: nothing to validate");
		const result = deps.roundResults.get(last.round);
		if (!result?.source) {
			const code = result?.sourceError?.code ?? "CANDIDATE_BUILD_FAILED";
			const res: ValidationResult = {
				status: code === "PATH_ESCAPE" ? "invalid" : "repairable",
				failureCode: code,
				detail: result?.sourceError?.message ?? "the round sealed no source",
				certification: { verdict: "-", complete: false, checks: [], bindings: {}, digest: "", dir: "" },
			};
			return {
				validations: [{ round: last.round, sourceRevision: last.sourceRevision, manifestDigest: "", result: res }],
			};
		}
		const res = await deps.validation.validate({
			round: last.round,
			sealedDir: result.sealedDir,
			source: result.source,
			sourceRevision: last.sourceRevision,
		});
		ctx.log("validate", {
			round: last.round,
			status: res.status,
			failureCode: "failureCode" in res ? res.failureCode : undefined,
		});
		return {
			validations: [
				{
					round: last.round,
					sourceRevision: last.sourceRevision,
					manifestDigest: result.source.manifestDigest,
					result: res,
				},
			],
		};
	};
}
