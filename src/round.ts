// One coding round (DD-03 §1, P12-03): what the trusted coordinator hands
// the Pi coder (a root-owned, candidate-readable round.json in the round
// directory) and what the coder leaves behind for the trusted side to read
// as data (outcome.json in its own workspace). The round input binds the
// coder to the frozen plan, the exact source revision, the route, the
// limits and the trusted prompt; nothing in it is discovered.

import type { Money } from "./adapters/sidecar.js";
import { parseStrictObject, validateSchema } from "./contracts.js";

export interface RoundLimits {
	maxCalls: number;
	maxOutputTokens: number;
	/** What Control reserves for one send (every call declares it). */
	exposurePerSend: Money;
	exposure: Money;
	aggregateCalls: number;
	aggregateExposure: Money;
}

export interface RoundInput {
	schemaVersion: 1;
	round: number;
	kind: "code" | "repair";
	callIdPrefix: string;
	routeId: string;
	model: { contextWindow: number; maxTokens: number };
	limits: RoundLimits;
	deadline: string;
	compaction: { enabled: boolean; reserveTokens: number; keepRecentTokens: number };
	systemPrompt: string;
	tools: string[];
	/** The turn's user prompt: the frozen plan and brief, or the findings to repair. */
	prompt: string;
	/** The source revision this round writes (the content authority's, never the coder's). */
	sourceRevision: string;
	/** The workspace root the source and session directories lie under (real directories only between them). */
	workspace: string;
	sourceDir: string;
	sessionDir: string;
	/** The sealed session of the previous round to continue from (copied into sessionDir by the coder). */
	continueSession?: string;
	/**
	 * The trusted side's read-only prior tree (a repair launch's proven
	 * source of the prior attempt): the coder replaces its own source
	 * directory with a copy of it before the round, so it writes as the
	 * candidate identity what it repairs.
	 */
	priorSource?: string;
	socket: string;
}

/**
 * How the call that ended a round failed: refused before any send (by the
 * sidecar, the Proxy or Control's admission), the round's own allowance or
 * the deadline before a send, an outcome that is not established, a send
 * that failed or was canceled definitely.
 */
export type CallFailure = "refused" | "allowance" | "deadline" | "uncertain" | "failed" | "canceled";

export interface RoundOutcome {
	schemaVersion: 1;
	round: number;
	sessionFile: string;
	calls: number;
	ended: "completed" | "call_failed" | "aborted" | "error";
	error?: string;
	failureCode?: string;
	failure?: CallFailure;
}

const money = {
	type: "object",
	additionalProperties: false,
	required: ["currency", "amount"],
	properties: {
		currency: { type: "string", pattern: "^[A-Z]{3}$" },
		amount: { type: "string", pattern: "^(0|[1-9][0-9]{0,29})$" },
	},
};

export const roundInputSchema: Record<string, unknown> = {
	type: "object",
	additionalProperties: false,
	required: [
		"schemaVersion",
		"round",
		"kind",
		"callIdPrefix",
		"routeId",
		"model",
		"limits",
		"deadline",
		"compaction",
		"systemPrompt",
		"tools",
		"prompt",
		"sourceRevision",
		"workspace",
		"sourceDir",
		"sessionDir",
		"socket",
	],
	properties: {
		schemaVersion: { const: 1 },
		round: { type: "integer", minimum: 1, maximum: 64 },
		kind: { enum: ["code", "repair"] },
		callIdPrefix: { type: "string", minLength: 1, maxLength: 96, pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]*$" },
		routeId: { type: "string", minLength: 1, maxLength: 128, pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]*$" },
		model: {
			type: "object",
			additionalProperties: false,
			required: ["contextWindow", "maxTokens"],
			properties: {
				contextWindow: { type: "integer", minimum: 1024 },
				maxTokens: { type: "integer", minimum: 1, maximum: 262144 },
			},
		},
		limits: {
			type: "object",
			additionalProperties: false,
			required: ["maxCalls", "maxOutputTokens", "exposurePerSend", "exposure", "aggregateCalls", "aggregateExposure"],
			properties: {
				maxCalls: { type: "integer", minimum: 1 },
				maxOutputTokens: { type: "integer", minimum: 1, maximum: 262144 },
				exposurePerSend: money,
				exposure: money,
				aggregateCalls: { type: "integer", minimum: 1 },
				aggregateExposure: money,
			},
		},
		deadline: { type: "string", pattern: "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\\.[0-9]{1,9})?Z$" },
		compaction: {
			type: "object",
			additionalProperties: false,
			required: ["enabled", "reserveTokens", "keepRecentTokens"],
			properties: {
				enabled: { type: "boolean" },
				reserveTokens: { type: "integer", minimum: 0 },
				keepRecentTokens: { type: "integer", minimum: 0 },
			},
		},
		systemPrompt: { type: "string", minLength: 1, maxLength: 65536 },
		tools: { type: "array", maxItems: 8, items: { enum: ["read", "write", "edit", "ls", "grep", "find"] } },
		prompt: { type: "string", minLength: 1, maxLength: 262144 },
		sourceRevision: { type: "string", pattern: "^(0|[1-9][0-9]{0,19})$" },
		workspace: { type: "string", minLength: 1 },
		sourceDir: { type: "string", minLength: 1 },
		sessionDir: { type: "string", minLength: 1 },
		continueSession: { type: "string", minLength: 1 },
		priorSource: { type: "string", minLength: 1 },
		socket: { type: "string", minLength: 1 },
	},
};

export function parseRoundInput(text: string): RoundInput {
	const raw = parseStrictObject(text, "round input");
	const problem = validateSchema(roundInputSchema, raw);
	if (problem) throw new Error(`round input: ${problem}`);
	return raw as unknown as RoundInput;
}

export const roundOutcomeSchema: Record<string, unknown> = {
	type: "object",
	additionalProperties: false,
	required: ["schemaVersion", "round", "sessionFile", "calls", "ended"],
	properties: {
		schemaVersion: { const: 1 },
		round: { type: "integer", minimum: 1 },
		sessionFile: { type: "string", minLength: 1, maxLength: 4096 },
		calls: { type: "integer", minimum: 0 },
		ended: { enum: ["completed", "call_failed", "aborted", "error"] },
		error: { type: "string", maxLength: 4096 },
		failureCode: { type: "string", maxLength: 64 },
		failure: { enum: ["refused", "allowance", "deadline", "uncertain", "failed", "canceled"] },
	},
};

export function parseRoundOutcome(text: string): RoundOutcome {
	const raw = parseStrictObject(text, "round outcome");
	const problem = validateSchema(roundOutcomeSchema, raw);
	if (problem) throw new Error(`round outcome: ${problem}`);
	return raw as unknown as RoundOutcome;
}
