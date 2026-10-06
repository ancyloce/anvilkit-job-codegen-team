// The team's reviewed configuration (team.yaml, root-owned in the image
// beside the supervisor's config.yaml): the route the roles use and what
// Control reserves for one send on it, every bound the run must hold —
// parallelism, per-role and aggregate calls, the aggregate exposure, output
// tokens, review and repair counts, compaction, source and session sizes —
// and the validation step. Nothing here has a default: a limit the file
// does not state is a refusal, never an invented allowance.
import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import type { Money } from "./adapters/sidecar.js";
import { TeamBudget } from "./budget.js";
import { validateSchema } from "./contracts.js";
import type { Role } from "./port/model.js";

export interface RoleLimits {
	maxCalls: number;
	maxOutputTokens: number;
}

export interface ValidatorConfig {
	/** The validator package root (dist/cli.js, profiles/, node_modules/). */
	package: string;
	node: string;
	/** How the validator's build, SSR and browser steps take the candidate identity. */
	identity: "setpriv" | "caller";
	uid?: number;
	gid?: number;
	ssr: boolean;
	browser: boolean;
	timeoutSeconds: number;
	buildSupportProfile: string;
	hostAbi: string;
	validatorProfile: string;
	/** The directory the validator finds the contract schemas in (ANVILKIT_VALIDATOR_CONTRACTS_DIR). */
	contractsDir?: string;
	/** PLAYWRIGHT_BROWSERS_PATH for the browser step. */
	browsersPath?: string;
}

export interface TeamConfig {
	schemaVersion: 1;
	/**
	 * The reviewed Model Proxy route. exposurePerSend is what Control reserves
	 * for one send on it — the Proxy reserves the route's max_exposure for
	 * every send, whatever a caller declares — and must equal that bound.
	 */
	route: { id: string; contextWindow: number; maxTokens: number; exposurePerSend: Money };
	currency: string;
	parallelism: number;
	recursionLimit: number;
	deadlineMarginSeconds: number;
	roles: Record<Role, RoleLimits>;
	aggregate: { maxCalls: number; exposure: Money };
	reviews: { max: number };
	repairs: { max: number };
	compaction: { enabled: boolean; reserveTokens: number; keepRecentTokens: number };
	tools: string[];
	source: {
		maxFiles: number;
		maxFileBytes: number;
		maxTotalBytes: number;
		maxSessionBytes: number;
		maxReviewBytes: number;
	};
	validation: { mode: "validator" | "none" } & { validator?: ValidatorConfig };
}

const amount = { type: "string", pattern: "^(0|[1-9][0-9]{0,29})$" };
const roleLimits = {
	type: "object",
	additionalProperties: false,
	required: ["maxCalls", "maxOutputTokens"],
	properties: {
		maxCalls: { type: "integer", minimum: 1, maximum: 4096 },
		maxOutputTokens: { type: "integer", minimum: 1, maximum: 262144 },
	},
};

export const teamConfigSchema: Record<string, unknown> = {
	type: "object",
	additionalProperties: false,
	required: [
		"schemaVersion",
		"route",
		"currency",
		"parallelism",
		"recursionLimit",
		"deadlineMarginSeconds",
		"roles",
		"aggregate",
		"reviews",
		"repairs",
		"compaction",
		"tools",
		"source",
		"validation",
	],
	properties: {
		schemaVersion: { const: 1 },
		route: {
			type: "object",
			additionalProperties: false,
			required: ["id", "contextWindow", "maxTokens", "exposurePerSend"],
			properties: {
				id: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$" },
				contextWindow: { type: "integer", minimum: 1024 },
				maxTokens: { type: "integer", minimum: 1, maximum: 262144 },
				exposurePerSend: amount,
			},
		},
		currency: { type: "string", pattern: "^[A-Z]{3}$" },
		// LangGraph 1.4.15 ends a run after the first task of a Send fan-out
		// under maxConcurrency 1 (observed); the reviewer fan-out needs 2.
		parallelism: { type: "integer", minimum: 2, maximum: 8 },
		recursionLimit: { type: "integer", minimum: 8, maximum: 1024 },
		deadlineMarginSeconds: { type: "integer", minimum: 1, maximum: 3600 },
		roles: {
			type: "object",
			additionalProperties: false,
			required: ["planner", "retrieval", "coder", "code_reviewer", "security_reviewer"],
			properties: {
				planner: roleLimits,
				retrieval: roleLimits,
				coder: roleLimits,
				code_reviewer: roleLimits,
				security_reviewer: roleLimits,
			},
		},
		aggregate: {
			type: "object",
			additionalProperties: false,
			required: ["maxCalls", "exposure"],
			properties: { maxCalls: { type: "integer", minimum: 1, maximum: 8192 }, exposure: amount },
		},
		reviews: {
			type: "object",
			additionalProperties: false,
			required: ["max"],
			properties: { max: { type: "integer", minimum: 0, maximum: 16 } },
		},
		repairs: {
			type: "object",
			additionalProperties: false,
			required: ["max"],
			properties: { max: { type: "integer", minimum: 0, maximum: 16 } },
		},
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
		tools: {
			type: "array",
			minItems: 1,
			maxItems: 6,
			uniqueItems: true,
			items: { enum: ["read", "write", "edit", "ls", "grep", "find"] },
		},
		source: {
			type: "object",
			additionalProperties: false,
			required: ["maxFiles", "maxFileBytes", "maxTotalBytes", "maxSessionBytes", "maxReviewBytes"],
			properties: {
				maxFiles: { type: "integer", minimum: 1, maximum: 4096 },
				maxFileBytes: { type: "integer", minimum: 1 },
				maxTotalBytes: { type: "integer", minimum: 1 },
				maxSessionBytes: { type: "integer", minimum: 1 },
				maxReviewBytes: { type: "integer", minimum: 1024 },
			},
		},
		validation: {
			type: "object",
			additionalProperties: false,
			required: ["mode"],
			properties: {
				mode: { enum: ["validator", "none"] },
				validator: {
					type: "object",
					additionalProperties: false,
					required: [
						"package",
						"node",
						"identity",
						"ssr",
						"browser",
						"timeoutSeconds",
						"buildSupportProfile",
						"hostAbi",
						"validatorProfile",
					],
					properties: {
						package: { type: "string", minLength: 1 },
						node: { type: "string", minLength: 1 },
						identity: { enum: ["setpriv", "caller"] },
						uid: { type: "integer", minimum: 1 },
						gid: { type: "integer", minimum: 1 },
						ssr: { type: "boolean" },
						browser: { type: "boolean" },
						timeoutSeconds: { type: "integer", minimum: 10, maximum: 7200 },
						buildSupportProfile: { type: "string", minLength: 1 },
						hostAbi: { type: "string", minLength: 1 },
						validatorProfile: { type: "string", minLength: 1 },
						contractsDir: { type: "string", minLength: 1 },
						browsersPath: { type: "string", minLength: 1 },
					},
				},
			},
			// A JSON Schema conditional ("then" is the keyword, not a promise member).
			if: { properties: { mode: { const: "validator" } } },
			// biome-ignore lint/suspicious/noThenProperty: JSON Schema keyword
			then: { required: ["validator"] },
		},
	},
};

/** Parses and validates the team configuration; a missing or malformed limit refuses the run. */
export function parseTeamConfig(text: string): TeamConfig {
	let raw: unknown;
	try {
		raw = parseYaml(text, { uniqueKeys: true, strict: true });
	} catch (err) {
		throw new Error(`team configuration: ${(err as Error).message}`);
	}
	const problem = validateSchema(teamConfigSchema, raw);
	if (problem) throw new Error(`team configuration: ${problem}`);
	const cfg = raw as {
		route: { id: string; contextWindow: number; maxTokens: number; exposurePerSend: string };
		aggregate: { maxCalls: number; exposure: string };
		currency: string;
		validation: { mode: "validator" | "none"; validator?: ValidatorConfig };
	} & Omit<TeamConfig, "route" | "aggregate" | "validation">;
	const money = (a: string): Money => ({ currency: cfg.currency, amount: a });
	const perSend = BigInt(cfg.route.exposurePerSend);
	if (perSend <= 0n) throw new Error("team configuration: route.exposurePerSend must be positive");
	if (BigInt(cfg.aggregate.exposure) < perSend)
		throw new Error("team configuration: aggregate.exposure funds no send at route.exposurePerSend");
	for (const [name, r] of Object.entries(cfg.roles) as Array<[Role, RoleLimits]>) {
		if (r.maxOutputTokens > cfg.route.maxTokens)
			throw new Error(`team configuration: roles.${name}: maxOutputTokens exceeds route.maxTokens`);
	}
	if (cfg.validation.mode === "validator") {
		const v = cfg.validation.validator as ValidatorConfig;
		if (v.identity === "setpriv" && (v.uid === undefined || v.gid === undefined))
			throw new Error("team configuration: validation.validator: setpriv needs uid and gid");
	}
	return {
		...cfg,
		route: { ...cfg.route, exposurePerSend: money(cfg.route.exposurePerSend) },
		aggregate: { maxCalls: cfg.aggregate.maxCalls, exposure: money(cfg.aggregate.exposure) },
	};
}

export function loadTeamConfig(path: string): TeamConfig {
	return parseTeamConfig(readFileSync(path, "utf8"));
}

/** The run's budget rules over the configuration's limits. */
export function teamBudget(config: TeamConfig): TeamBudget {
	return new TeamBudget({
		currency: config.currency,
		exposurePerSend: BigInt(config.route.exposurePerSend.amount),
		roles: config.roles,
		aggregate: { maxCalls: config.aggregate.maxCalls, exposure: BigInt(config.aggregate.exposure.amount) },
	});
}
