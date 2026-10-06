// The coordinator's recovery decision (DD-03 §3): Control first. An attempt
// whose result Control accepted has its boundary; the local objects must
// prove to belong to it, and nothing runs again. Otherwise a repair launch
// across attempts (P13-04) names the prior attempt's accepted stage and
// source as its inputs: they are proven against Control's record of that
// attempt before its sealed source becomes the tree this attempt repairs,
// and the repair and review counters and the budget accounting continue
// from the prior manifest — they never reset. Nothing of the prior attempt's calls is replayed: the
// run is new, seeded from a proven computation boundary. Without those
// inputs the run starts fresh from the frozen brief.
import { readFileSync } from "node:fs";
import path from "node:path";
import type { BudgetState } from "../budget.js";
import { type Digest, sha256 } from "../digest.js";
import { stageArchiveMember } from "../stage/archive.js";
import { type StageManifest, StageRefusedError } from "../stage/manifest.js";
import { importPrior, type ProvenStage } from "../stage/proof.js";
import type { StageStore } from "../stage/store.js";
import type { Brief } from "../team/roles.js";
import type { RoundSummary, ValidationRecord } from "../team/state.js";
import { type CoordinatorInputs, parseBrief } from "./inputs.js";

/** What a prior accepted stage seeds into this attempt's run. */
export interface PriorSeed {
	sourceRevision: string;
	round: RoundSummary;
	validation: ValidationRecord;
	repairs: number;
	reviewRounds: number;
	budget: BudgetState;
}

export type Recovery =
	| { kind: "accepted"; proven: ProvenStage }
	| { kind: "run"; brief: Brief & { sourceRevision: string }; prior?: PriorSeed };

export async function decideRecovery(
	inputs: CoordinatorInputs,
	store: StageStore,
	log: (event: string, fields?: Record<string, unknown>) => void,
): Promise<Recovery> {
	const proven = await store.recover(inputs.scope);
	if (proven) return { kind: "accepted", proven };
	if (!inputs.envelope.inputs.some((i) => i.name === "brief"))
		throw new Error("the launch envelope names no brief input");
	const brief = parseBrief(readFileSync(path.join(inputs.inputDir, "brief"), "utf8"));
	return { kind: "run", brief, prior: await importPriorBoundary(inputs, log) };
}

async function importPriorBoundary(
	inputs: CoordinatorInputs,
	log: (event: string, fields?: Record<string, unknown>) => void,
): Promise<PriorSeed | undefined> {
	const { envelope, inputDir, sidecar, scope, profileDigest, workspace, config } = inputs;
	const stageInput = envelope.inputs.find((i) => i.name === "stage");
	const sourceInput = envelope.inputs.find((i) => i.name === "source");
	if (!stageInput && !sourceInput) return undefined;
	if (!stageInput || !sourceInput)
		throw new Error("a repair launch names both the stage and the source input of the prior attempt");
	const stage = readFileSync(path.join(inputDir, "stage"));
	const source = readFileSync(path.join(inputDir, "source"));
	// The prior attempt is what the stage manifest names; Control's answer
	// for it is the authority the archives are proven against.
	const manifestBytes = (await stageArchiveMember(stage, "manifest.json")) ?? Buffer.alloc(0);
	let priorAttemptId = "";
	try {
		priorAttemptId = (JSON.parse(manifestBytes.toString("utf8")) as StageManifest).identity.attemptId;
	} catch {
		throw new StageRefusedError("STALE_STAGE", "the prior stage archive holds no readable manifest");
	}
	const accepted = await sidecar.priorStage(priorAttemptId);
	if (!accepted)
		throw new StageRefusedError(
			"STALE_STAGE",
			`Control records no accepted stage of attempt ${priorAttemptId} for this operation`,
		);
	const sourceDir = path.join(workspace, "w", "source");
	const boundary = await importPrior(
		{ stage, source, stageDigest: stageInput.digest as Digest, sourceDigest: sourceInput.digest as Digest },
		accepted,
		scope,
		profileDigest,
		sourceDir,
		config.source,
	);
	let failureCode = "CANDIDATE_TEST_FAILED";
	let detail = "the independent validator classified the prior source repairable";
	const evidenceInput = envelope.inputs.find((i) => i.name === "evidence");
	if (evidenceInput) {
		const evidence = readFileSync(path.join(inputDir, "evidence"));
		if (sha256(evidence) !== evidenceInput.digest)
			throw new StageRefusedError(
				"STALE_STAGE",
				"the validator evidence does not hash to the launch envelope's digest",
			);
		try {
			const doc = JSON.parse(evidence.toString("utf8")) as {
				certification?: { failureCode?: string; checks?: Array<{ name: string; status: string; detail?: string }> };
				failureCode?: string;
			};
			failureCode = doc.certification?.failureCode ?? doc.failureCode ?? failureCode;
			const failing = (doc.certification?.checks ?? []).filter((c) => c.status === "fail");
			if (failing.length > 0)
				detail = failing
					.map((c) => `${c.name}: ${c.detail ?? ""}`)
					.join("; ")
					.slice(0, 4000);
		} catch {
			throw new StageRefusedError("STALE_STAGE", "the validator evidence is not a JSON document");
		}
	}
	const priorRound = boundary.manifest.counters.rounds;
	const round: RoundSummary = {
		round: priorRound,
		kind: priorRound > 1 ? "repair" : "code",
		sourceRevision: boundary.sourceRevision,
		sealedDir: sourceDir,
		manifestDigest: boundary.manifest.source?.manifestDigest,
		files: boundary.files.length,
		calls: 0,
		stop: "imported",
	};
	const validation: ValidationRecord = {
		round: priorRound,
		sourceRevision: boundary.sourceRevision,
		manifestDigest: boundary.manifest.source?.manifestDigest ?? "",
		result: {
			status: "repairable",
			failureCode,
			detail,
			certification: {
				verdict: "repairable",
				failureCode,
				complete: true,
				checks: [],
				bindings: {},
				digest: evidenceInput?.digest ?? "",
				dir: "",
			},
		},
	};
	log("prior accepted boundary imported", {
		priorAttemptId,
		stageId: accepted.stageId,
		sourceRevision: boundary.sourceRevision,
		files: boundary.files.length,
		repairs: boundary.manifest.counters.repairs,
		failureCode,
	});
	return {
		sourceRevision: boundary.sourceRevision,
		round,
		validation,
		repairs: boundary.manifest.counters.repairs,
		reviewRounds: boundary.manifest.counters.reviewRounds,
		budget: boundary.manifest.budget,
	};
}
