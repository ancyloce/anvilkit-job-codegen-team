// What the team's nodes are built over: the ports, the reviewed
// configuration and budget, the attempt's absolute deadline (never reset),
// and the per-role call ordinals that keep call identities deterministic
// across a restart of the same run.
import type { Money, ProgressRecord, ProgressReport } from "../adapters/sidecar.js";
import type { TeamBudget } from "../budget.js";
import { type TeamConfig, teamBudget } from "../config.js";
import type { CodingExecutor, RoundResult } from "../executor.js";
import { type ControlledModelPort, DeadlineExceededError, type ModelCallResult, type Role } from "../port/model.js";
import type { ValidationPort } from "../validation.js";
import type { Prompts, RetrievalPort } from "./roles.js";

export interface TeamDeps {
	config: TeamConfig;
	prompts: Prompts;
	port: ControlledModelPort;
	executor: CodingExecutor;
	retrieval: RetrievalPort;
	validation: ValidationPort;
	deadline: Date;
	now?: () => Date;
	/** The sealed rounds by number (the executor's results, needed to continue a session). */
	roundResults: Map<number, RoundResult>;
	log?: (event: string, fields?: Record<string, unknown>) => void;
	/** The operation's unreserved budget at the start (P2.4): clamps the run's aggregate exposure. */
	budgetHeadroom?: Money;
	/**
	 * The trusted sidecar's progress route (plan 0005 Phase 2): node
	 * boundaries for display. Absent in environments without it; a refusal
	 * never changes the run.
	 */
	progress?: ProgressReporter;
}

export interface ProgressReporter {
	progress(report: ProgressReport): Promise<ProgressRecord>;
}

export interface NodeContext {
	deps: TeamDeps;
	budget: TeamBudget;
	now: () => Date;
	log: (event: string, fields?: Record<string, unknown>) => void;
	/**
	 * Reports a node boundary for display through the trusted sidecar (plan
	 * 0005 Phase 2). Best effort: a refusal or an unavailable route is logged
	 * and ignored, so progress can never fail, delay beyond its timeout or
	 * steer the run; it is never a verdict.
	 */
	report(
		node: ProgressReport["node"],
		state: ProgressReport["state"],
		round?: number,
		outcomeCode?: string,
	): Promise<void>;
	/** The next call ordinal of a role. */
	nextOrdinal(role: Role): number;
	/** Throws DeadlineExceededError when the deadline margin is reached. */
	guardDeadline(node: string): void;
	/** Whether the deadline margin is reached. */
	pastDeadline(): boolean;
}

export function nodeContext(deps: TeamDeps): NodeContext {
	const now = deps.now ?? (() => new Date());
	const ordinals = new Map<Role, number>();
	const past = () => now().getTime() + deps.config.deadlineMarginSeconds * 1000 >= deps.deadline.getTime();
	return {
		deps,
		budget: teamBudget(deps.config, deps.budgetHeadroom),
		now,
		log: deps.log ?? (() => {}),
		nextOrdinal(role) {
			const n = (ordinals.get(role) ?? 0) + 1;
			ordinals.set(role, n);
			return n;
		},
		guardDeadline(node) {
			if (past()) throw new DeadlineExceededError(`${node}: the deadline ${deps.deadline.toISOString()} is reached`);
		},
		pastDeadline: past,
		async report(node, state, round, outcomeCode) {
			if (!deps.progress) return;
			const report: ProgressReport = { node, state };
			if (round !== undefined) report.round = String(round);
			if (outcomeCode) report.outcomeCode = outcomeCode;
			try {
				await deps.progress.progress(report);
			} catch (err) {
				(deps.log ?? (() => {}))("progress not recorded", { node, state, round, error: (err as Error).message });
			}
		},
	};
}

/** Counts a node's own calls (each at the per-send exposure) for its charge. */
export function callCounter() {
	let calls = 0;
	let exposure = 0n;
	return {
		onResult: (r: ModelCallResult) => {
			calls++;
			exposure += BigInt(r.exposure.amount);
		},
		calls: () => calls,
		exposure: () => exposure,
	};
}
