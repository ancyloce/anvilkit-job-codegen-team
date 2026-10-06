// The specialist nodes (DD-03 §1): Planner, Retrieval specialist and the two
// reviewers. Each states the allowance it has left before a call — the
// role's remaining budget, or for a reviewer the share reserved for it
// before the fan-out — and charges its calls at the per-send exposure.
import { addBudget, TeamBudget } from "../../budget.js";
import type { Role } from "../../port/model.js";
import type { NodeContext } from "../context.js";
import { callCounter } from "../context.js";
import { type Findings, type Plan, planUser, renderSource, reviewUser, runSpecialist, tool } from "../roles.js";
import type { TeamStateType } from "../state.js";

type Node = (state: TeamStateType) => Promise<Partial<TeamStateType>>;

/** The roles that review one revision in parallel, in the order their reservations are taken. */
export const reviewerRoles = ["code_reviewer", "security_reviewer"] as const satisfies readonly Role[];

export function planNode(ctx: NodeContext): Node {
	const { deps, budget } = ctx;
	return async (state) => {
		ctx.guardDeadline("plan");
		const c = callCounter();
		const { value } = await runSpecialist<Plan>(deps.port, {
			role: "planner",
			systemPrompt: deps.prompts.planner,
			user: planUser(state.brief, state.sourceRevision),
			tool: tool("submit_plan"),
			maxOutputTokens: deps.config.roles.planner.maxOutputTokens,
			exposure: budget.perSend,
			remaining: () => budget.remaining(addBudget(state.budget, budget.charge("planner", c.calls())), "planner"),
			nextOrdinal: () => ctx.nextOrdinal("planner"),
			onResult: c.onResult,
			accept: (args) => {
				const p = args as unknown as Plan;
				if (p.componentId !== state.brief.componentId)
					return { ok: false, reason: `componentId ${p.componentId} is not the brief's ${state.brief.componentId}` };
				if (p.puckType !== state.brief.puckType)
					return { ok: false, reason: `puckType ${p.puckType} is not the brief's ${state.brief.puckType}` };
				return { ok: true, value: p };
			},
		});
		ctx.log("plan", { steps: value.steps.length, calls: c.calls() });
		return { plan: value, budget: budget.charge("planner", c.calls()) };
	};
}

export function retrieveNode(ctx: NodeContext): Node {
	const { deps, budget } = ctx;
	return async (state) => {
		ctx.guardDeadline("retrieve");
		const question = `Which reviewed conventions apply to a ${state.brief.puckType} component of this project?`;
		const found = await deps.retrieval.retrieve(question);
		if (found.status === "insufficient_evidence") {
			// No evidence, no call: the specialist has nothing to cite.
			ctx.log("retrieve", { status: found.status });
			return { retrieval: { status: "insufficient_evidence", reason: found.reason, calls: 0 } };
		}
		const c = callCounter();
		const ids = new Set(found.evidence.map((e) => e.id));
		const evidence = found.evidence.map((e) => `[${e.id}] (${e.source}) ${e.text}`).join("\n");
		const { value } = await runSpecialist<{ answer: string; citations: string[] }>(deps.port, {
			role: "retrieval",
			systemPrompt: deps.prompts.retrieval,
			user: `Question: ${question}\n\nEvidence:\n${evidence}\n\nAnswer with submit_retrieval, citing only the evidence ids above.`,
			tool: tool("submit_retrieval"),
			maxOutputTokens: deps.config.roles.retrieval.maxOutputTokens,
			exposure: budget.perSend,
			remaining: () => budget.remaining(addBudget(state.budget, budget.charge("retrieval", c.calls())), "retrieval"),
			nextOrdinal: () => ctx.nextOrdinal("retrieval"),
			onResult: c.onResult,
			accept: (args) => {
				const v = args as { answer: string; citations: string[] };
				const invented = v.citations.filter((x) => !ids.has(x));
				if (invented.length > 0)
					return { ok: false, reason: `citations ${invented.join(", ")} are not among the returned evidence` };
				if (v.citations.length === 0) return { ok: false, reason: "an answer must cite the evidence it rests on" };
				return { ok: true, value: v };
			},
		});
		ctx.log("retrieve", { status: "evidence", citations: value.citations.length, calls: c.calls() });
		return {
			retrieval: { status: "evidence", answer: value.answer, citations: value.citations, calls: c.calls() },
			budget: budget.charge("retrieval", c.calls()),
		};
	};
}

/** The fan-out point: one step, before both reviewers run, reserves what each may spend from the budget the state holds now. */
export function reviewFanOutNode(ctx: NodeContext): Node {
	return async (state) => ({ reservations: ctx.budget.reserveParallel(state.budget, reviewerRoles) });
}

export function reviewerNode(ctx: NodeContext, role: (typeof reviewerRoles)[number]): Node {
	const { deps, budget } = ctx;
	return async (state) => {
		ctx.guardDeadline(role);
		const last = state.rounds[state.rounds.length - 1];
		if (!last || !state.plan) throw new Error(`${role}: nothing to review`);
		const result = deps.roundResults.get(last.round);
		if (!result?.source) throw new Error(`${role}: round ${last.round} sealed no source`);
		// The allowance is the share reserved for this reviewer before the
		// fan-out, less what it has spent itself: the other reviewer's
		// concurrent sends can never be funded by the same reserved send.
		const reserved = state.reservations?.[role];
		if (!reserved) throw new Error(`${role}: no allowance was reserved for this review round`);
		const c = callCounter();
		const rendered = renderSource(result.sealedDir, result.source, deps.config.source.maxReviewBytes);
		const { value } = await runSpecialist<Findings>(deps.port, {
			role,
			systemPrompt: role === "code_reviewer" ? deps.prompts.code_reviewer : deps.prompts.security_reviewer,
			user: reviewUser(state.plan, last.sourceRevision, rendered),
			tool: tool("submit_findings"),
			maxOutputTokens: deps.config.roles[role].maxOutputTokens,
			exposure: budget.perSend,
			remaining: () => TeamBudget.less(reserved, c.calls(), c.exposure()),
			nextOrdinal: () => ctx.nextOrdinal(role),
			onResult: c.onResult,
			accept: (args) => {
				const f = args as unknown as Findings;
				const known = new Set(result.source?.files.map((x) => x.path));
				const unknown = f.findings.filter((x) => !known.has(x.file));
				if (unknown.length > 0)
					return {
						ok: false,
						reason: `findings name files not in the revision: ${unknown.map((x) => x.file).join(", ")}`,
					};
				if (f.verdict === "pass" && f.findings.some((x) => x.severity !== "minor"))
					return { ok: false, reason: "verdict pass with blocker or major findings" };
				return { ok: true, value: f };
			},
		});
		ctx.log(role, { round: last.round, verdict: value.verdict, findings: value.findings.length, calls: c.calls() });
		return {
			reviews: [
				{
					round: last.round,
					role,
					sourceRevision: last.sourceRevision,
					manifestDigest: result.source.manifestDigest,
					verdict: value.verdict,
					findings: value.findings,
					calls: c.calls(),
				},
			],
			budget: budget.charge(role, c.calls()),
		};
	};
}

export function reviewJoinNode(): Node {
	return async () => ({ reviewRounds: 1 });
}
