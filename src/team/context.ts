// What the team's nodes are built over: the ports, the reviewed
// configuration and budget, the attempt's absolute deadline (never reset),
// and the per-role call ordinals that keep call identities deterministic
// across a restart of the same run.
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
}

export interface NodeContext {
	deps: TeamDeps;
	budget: TeamBudget;
	now: () => Date;
	log: (event: string, fields?: Record<string, unknown>) => void;
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
		budget: teamBudget(deps.config),
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
