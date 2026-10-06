// The joint stage manifest of a team attempt (DD-03 §3, delivery.md P12-05):
// what one accepted stage binds — the stage identity (launch, operation,
// attempt, instance, phase ordinal), the team profile digest, both epochs,
// the checkpoint snapshot, the sealed Pi session and source of the result
// round, the model calls with their outcomes, the budget and counters, the
// outcome — and the rules every recovery proof applies to it. A manifest of
// another format, attempt, operation, instance, epoch or team profile never
// becomes a boundary to build on.
import { readFileSync } from "node:fs";
import type { BudgetState } from "../budget.js";
import { type Digest, sequence, sha256 } from "../digest.js";
import type { TeamOutcome } from "../team/state.js";

/**
 * The manifest format. Version 2 accounts every call at the route's
 * per-send exposure; a stage of another format (version 1 included) is
 * refused, never read as this one.
 */
export const stageFormat = 2;

export interface StageIdentity {
	launchId: string;
	launchKey: string;
	tenantId: string;
	operationId: string;
	attemptId: string;
	instanceId: string;
	profileId: string;
	profileRevision: string;
	jobKind: string;
	executionEpoch: string;
	recoveryEpoch: string;
	launchEpoch: string;
	deadline: string;
}

export interface ObjectRef {
	digest: Digest;
	sizeBytes: string;
}

export interface StageManifest {
	schemaVersion: typeof stageFormat;
	stageKind: "codegen-team";
	identity: StageIdentity;
	phaseOrdinal: string;
	teamProfileDigest: Digest;
	checkpoint: { threadId: string; checkpointId?: string; snapshot: ObjectRef };
	session?: { round: number; sealed: ObjectRef };
	source?: {
		round: number;
		revision: string;
		manifestDigest: Digest;
		files: number;
		totalBytes: number;
		archive: ObjectRef;
	};
	validation?: { round: number; status: string; failureCode?: string; certificationDigest?: string };
	calls: Array<{ callId: string; role: string; outcome: string; code?: string }>;
	budget: BudgetState;
	counters: { rounds: number; reviewRounds: number; repairs: number };
	outcome: TeamOutcome;
	sealedAt: string;
}

export class StageRefusedError extends Error {
	constructor(
		readonly code: string,
		message: string,
	) {
		super(message);
		this.name = "StageRefusedError";
	}
}

/** The scope facts a manifest must name to belong to an attempt. */
export interface StageScope {
	operationId: string;
	attemptId: string;
	instanceId?: string;
	executionEpoch: string;
	recoveryEpoch: string;
}

/**
 * Parses a stage manifest's bytes and holds it to the binding rules: this
 * format and kind, the scope's operation and attempt (and instance, when
 * given), its epochs, and the team profile this build computes. Throws the
 * refusal refuse() builds.
 */
export function boundManifest(
	bytes: Buffer,
	scope: StageScope,
	teamProfileDigest: Digest,
	refuse: (what: string) => StageRefusedError,
): StageManifest {
	let manifest: StageManifest;
	try {
		manifest = JSON.parse(bytes.toString("utf8")) as StageManifest;
	} catch {
		throw refuse("the stage manifest is not a JSON document");
	}
	if (manifest.schemaVersion !== stageFormat || manifest.stageKind !== "codegen-team")
		throw refuse(`the stage manifest has format ${String(manifest.schemaVersion)}, this build reads ${stageFormat}`);
	const id = manifest.identity;
	if (!id || id.operationId !== scope.operationId || id.attemptId !== scope.attemptId)
		throw refuse("the stage manifest names another operation or attempt");
	if (scope.instanceId !== undefined && id.instanceId !== scope.instanceId)
		throw refuse("the stage manifest names another instance");
	if (id.executionEpoch !== scope.executionEpoch || id.recoveryEpoch !== scope.recoveryEpoch)
		throw refuse("the stage manifest was sealed under other epochs");
	if (manifest.teamProfileDigest !== teamProfileDigest)
		throw refuse("the stage manifest was sealed under another team profile");
	return manifest;
}

/** The verdict and failure code of the jobs contract for a team outcome (a fixed map; the exact class stays in the evidence). */
export function verdictFor(outcome: TeamOutcome): {
	verdict: "certified" | "repairable" | "invalid" | "infrastructure_failed" | "canceled";
	failureCode: string;
} {
	switch (outcome.kind) {
		case "certified":
			return { verdict: "certified", failureCode: "" };
		case "repairable":
			return { verdict: "repairable", failureCode: outcome.failureCode ?? "CANDIDATE_TEST_FAILED" };
		case "invalid":
			return { verdict: "invalid", failureCode: outcome.failureCode ?? "CANDIDATE_TEST_FAILED" };
		case "deadline":
			return { verdict: "infrastructure_failed", failureCode: "DEADLINE_EXCEEDED" };
		case "canceled":
			return { verdict: "canceled", failureCode: "CANCELED" };
		case "infrastructure_failed":
			return { verdict: "infrastructure_failed", failureCode: outcome.failureCode ?? "OBSERVER_FAILED" };
		default:
			// budget_exhausted, model_denied, effect_uncertain, validation_unavailable, failed:
			// the run did not reach a verdict about the candidate; the observer's own failure class is in the evidence.
			return { verdict: "infrastructure_failed", failureCode: "OBSERVER_FAILED" };
	}
}

/** The digest and size of a file's bytes. */
export function refOf(file: string): ObjectRef {
	const bytes = readFileSync(file);
	return { digest: sha256(bytes), sizeBytes: sequence(bytes.length) };
}
