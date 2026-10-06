// The coordinator's inputs (DD-03 §4–§6): what the Go supervisor hands it —
// the reviewed team configuration, the trusted prompts and reviewed tools of
// the explicit agent directory, the launch envelope, the workspace and the
// sidecar sockets — the execution scope Control confirms now (it must name
// the envelope's operation, attempt, profile and launch key), the attempt's
// absolute deadline (the earlier of the envelope's and the scope's, never
// reset), the stage identity, and the team profile digest every stage of
// this build is sealed and proven under.
import { readFileSync } from "node:fs";
import path from "node:path";
import { type Scope, SidecarClient } from "../adapters/sidecar.js";
import { loadTeamConfig, type TeamConfig } from "../config.js";
import { parseStrictObject, validateAgainst, validateSchema } from "../contracts.js";
import type { Digest } from "../digest.js";
import { loadProtocolContract } from "../protocol.js";
import { sha256Parts } from "../source.js";
import { type StageIdentity, stageFormat } from "../stage/manifest.js";
import { teamGraphRevision } from "../team/graph.js";
import { type Brief, loadPrompts, type Prompts } from "../team/roles.js";
import { reviewedToolsDocument } from "../team/tools.js";

export const env = {
	config: "ANVILKIT_TEAM_CONFIG",
	agentDir: "ANVILKIT_AGENT_DIR",
	workspace: "ANVILKIT_WORKSPACE",
	verdict: "ANVILKIT_VERDICT_DIR",
	trustedSocket: "ANVILKIT_TRUSTED_SOCKET",
	candidateSocket: "ANVILKIT_CANDIDATE_SOCKET",
	envelope: "ANVILKIT_LAUNCH_ENVELOPE",
	inputDir: "ANVILKIT_INPUT_DIR",
	observer: "ANVILKIT_OBSERVER_IDENTITY",
} as const;

export interface Envelope {
	schemaVersion: 1;
	launchId: string;
	launchKey: string;
	operationId: string;
	attemptId: string;
	profileId: string;
	profileRevision: string;
	jobKind: string;
	executionEpoch: string;
	launchEpoch: string;
	deadline: string;
	inputs: Array<{ name: string; digest: string; handle?: string }>;
}

export function parseEnvelope(text: string): Envelope {
	const raw = parseStrictObject(text, "launch envelope");
	const problem = validateAgainst("urn:anvilkit:jobs:v1#/$defs/launchEnvelope", raw);
	if (problem) throw new Error(`launch envelope: ${problem}`);
	return raw as unknown as Envelope;
}

// The frozen brief: the fixture of P12 (a string requirement) and the
// brief artifact the Preparation freezes (P13: the structured requirements
// object with the exact inputs it was derived from — prompt, answers,
// source revisions, brand/asset content digests — which the team reads
// as data and never as instructions). Only the members below exist.
const briefSchema: Record<string, unknown> = {
	type: "object",
	additionalProperties: false,
	required: ["schemaVersion", "componentId", "puckType", "packageName", "version", "requirements"],
	properties: {
		schemaVersion: { const: 1 },
		componentId: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$" },
		puckType: { type: "string", pattern: "^[A-Z][A-Za-z0-9]{0,63}$" },
		packageName: { type: "string", minLength: 1, maxLength: 214 },
		version: { type: "string", pattern: "^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)$" },
		requirements: {
			anyOf: [
				{ type: "string", minLength: 1, maxLength: 65536 },
				{
					type: "object",
					required: ["purpose", "content"],
					properties: { purpose: { type: "string" }, content: { type: "string" } },
				},
			],
		},
		sourceRevision: { type: "string", pattern: "^(0|[1-9][0-9]{0,19})$" },
		operationId: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$" },
		prompt: { type: "object" },
		answers: { type: "array", maxItems: 8 },
		sourceRevisions: { type: "array", maxItems: 64 },
		brandDigests: { type: "array", maxItems: 16 },
		assetDigests: { type: "array", maxItems: 64 },
	},
};

/** The frozen brief as the trusted input names it (brief.json of the launch inputs). */
export function parseBrief(text: string): Brief & { sourceRevision: string } {
	const raw = parseStrictObject(text, "brief");
	const problem = validateSchema(briefSchema, raw);
	if (problem) throw new Error(`brief: ${problem}`);
	const b = raw as unknown as {
		componentId: string;
		puckType: string;
		packageName: string;
		version: string;
		requirements: unknown;
		sourceRevision?: string;
	};
	return {
		componentId: b.componentId,
		puckType: b.puckType,
		packageName: b.packageName,
		version: b.version,
		requirements: typeof b.requirements === "string" ? b.requirements : JSON.stringify(b.requirements),
		sourceRevision: b.sourceRevision ?? "1",
	};
}

/**
 * The team profile digest: the graph's revision and the stage format of
 * this build, the reviewed configuration, the prompts and the reviewed
 * tools, in a fixed order. A stage sealed under any other of them is
 * refused by recovery (STALE_STAGE), never resumed.
 */
export function teamProfileDigest(configText: string, prompts: Prompts, toolsText: string): Digest {
	return sha256Parts([
		teamGraphRevision,
		`stage-format/${stageFormat}`,
		"team.yaml",
		configText,
		"planner",
		prompts.planner,
		"retrieval",
		prompts.retrieval,
		"coder",
		prompts.coder,
		"code_reviewer",
		prompts.code_reviewer,
		"security_reviewer",
		prompts.security_reviewer,
		"tools.json",
		toolsText,
	]);
}

export interface CoordinatorInputs {
	config: TeamConfig;
	configText: string;
	prompts: Prompts;
	profileDigest: Digest;
	envelope: Envelope;
	workspace: string;
	verdictDir: string;
	inputDir: string;
	trustedSocket: string;
	candidateSocket: string;
	observer: string;
	sidecar: SidecarClient;
	scope: Scope;
	deadline: Date;
	identity: StageIdentity;
}

export function required(name: string): string {
	const v = process.env[name];
	if (!v) throw new Error(`${name} is required`);
	return v;
}

/** Reads, checks and binds everything the run is built from. */
export async function prepareInputs(verdictDir: string): Promise<CoordinatorInputs> {
	loadProtocolContract();
	const configPath = required(env.config);
	const configText = readFileSync(configPath, "utf8");
	const config = loadTeamConfig(configPath);
	const agentDir = required(env.agentDir);
	const prompts = loadPrompts(agentDir);
	const toolsText = readFileSync(path.join(agentDir, "team", "tools.json"), "utf8");
	if (toolsText !== `${JSON.stringify(reviewedToolsDocument(), null, 2)}\n`)
		throw new Error("agent/team/tools.json is not the reviewed tools of this build");
	const envelope = parseEnvelope(required(env.envelope));
	const workspace = required(env.workspace);
	const trustedSocket = required(env.trustedSocket);
	const candidateSocket = required(env.candidateSocket);
	const sidecar = new SidecarClient(trustedSocket);
	const { scope } = await sidecar.scope();
	if (
		scope.attemptId !== envelope.attemptId ||
		scope.operationId !== envelope.operationId ||
		scope.profileId !== envelope.profileId ||
		scope.launchKey !== envelope.launchKey
	)
		throw new Error(
			`execution scope (${scope.operationId}/${scope.attemptId}/${scope.profileId}/${scope.launchKey}) does not match the launch envelope`,
		);
	const envelopeDeadline = new Date(envelope.deadline);
	const scopeDeadline = new Date(scope.deadline);
	const deadline = scopeDeadline < envelopeDeadline ? scopeDeadline : envelopeDeadline;
	return {
		config,
		configText,
		prompts,
		profileDigest: teamProfileDigest(configText, prompts, toolsText),
		envelope,
		workspace,
		verdictDir,
		inputDir: process.env[env.inputDir] ?? path.join(workspace, "input"),
		trustedSocket,
		candidateSocket,
		observer: process.env[env.observer] ?? "anvilkit-codegen-team",
		sidecar,
		scope,
		deadline,
		identity: {
			launchId: envelope.launchId,
			launchKey: envelope.launchKey,
			tenantId: scope.tenantId,
			operationId: scope.operationId,
			attemptId: scope.attemptId,
			instanceId: scope.instanceId,
			profileId: scope.profileId,
			profileRevision: envelope.profileRevision,
			jobKind: envelope.jobKind,
			executionEpoch: scope.executionEpoch,
			recoveryEpoch: scope.recoveryEpoch,
			launchEpoch: envelope.launchEpoch,
			deadline: deadline.toISOString(),
		},
	};
}
