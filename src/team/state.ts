// The team's graph state (DD-03 §1, delivery.md P12-04): what the fixed
// roles produce, the rounds and their validations, the counters and the
// budget accounting, carried through reducers and checkpointed by
// LangGraph after every step. Nothing in a checkpoint grants a send: a
// resumed run reenters its calls under the same identities.
import { Annotation } from "@langchain/langgraph";
import { type Allowance, addBudget, type BudgetState, zeroBudget } from "../budget.js";
import type { Role } from "../port/model.js";
import type { TeamOutcomeKind } from "../protocol.js";
import type { ValidationResult } from "../validation.js";
import type { Brief, Finding, Plan } from "./roles.js";

export type { TeamOutcomeKind } from "../protocol.js";

export interface RoundSummary {
	round: number;
	kind: "code" | "repair";
	sourceRevision: string;
	sealedDir: string;
	manifestDigest?: string;
	files?: number;
	sourceError?: { code: string; message: string };
	sessionDigest?: string;
	ended?: string;
	failureCode?: string;
	calls: number;
	stop: string;
}

export interface ReviewOutput {
	round: number;
	role: "code_reviewer" | "security_reviewer";
	sourceRevision: string;
	manifestDigest: string;
	verdict: "pass" | "repair";
	findings: Finding[];
	calls: number;
}

export interface RetrievalOutput {
	status: "evidence" | "insufficient_evidence";
	reason?: string;
	answer?: string;
	citations?: string[];
	calls: number;
}

export interface ValidationRecord {
	round: number;
	sourceRevision: string;
	manifestDigest: string;
	result: ValidationResult;
}

export interface TeamOutcome {
	kind: TeamOutcomeKind;
	failureCode?: string;
	detail: string;
	/** The round whose sealed source is the result (when one exists). */
	round?: number;
}

const concat = <T>(a: T[], b: T[]) => a.concat(b);

export const TeamState = Annotation.Root({
	brief: Annotation<Brief>,
	sourceRevision: Annotation<string>,
	plan: Annotation<Plan | undefined>,
	retrieval: Annotation<RetrievalOutput | undefined>,
	rounds: Annotation<RoundSummary[]>({ reducer: concat, default: () => [] }),
	reviews: Annotation<ReviewOutput[]>({ reducer: concat, default: () => [] }),
	reviewRounds: Annotation<number>({ reducer: (a, b) => a + b, default: () => 0 }),
	repairs: Annotation<number>({ reducer: (a, b) => a + b, default: () => 0 }),
	validations: Annotation<ValidationRecord[]>({ reducer: concat, default: () => [] }),
	budget: Annotation<BudgetState>({ reducer: addBudget, default: zeroBudget }),
	/** The non-overlapping allowances reserved for the reviewers of the current review round, before their fan-out. */
	reservations: Annotation<Partial<Record<Role, Allowance>> | undefined>,
	outcome: Annotation<TeamOutcome | undefined>,
});

export type TeamStateType = typeof TeamState.State;
