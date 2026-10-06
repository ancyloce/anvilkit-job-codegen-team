// Sealing the joint stage (DD-03 §3): when the graph has stopped writing, a
// consistent snapshot of the SqliteSaver database (better-sqlite3's online
// backup), the sealed Pi session and the sealed source of the result round
// are archived; the manifest binds them; the objects go through the
// sidecar's scoped transfers (each verified by Control by bytes, size and
// digest, held at an exact object version); the result manifest of the jobs
// contract names their handles; Control's acceptance is the single business
// commit. Multiple uploads are not atomic: an upload without an accepted
// result is nothing. A canceled launch submits nothing.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import type { SidecarClient } from "../adapters/sidecar.js";
import { validateAgainst } from "../contracts.js";
import type { Digest } from "../digest.js";
import { sequence } from "../digest.js";
import type { RoundResult } from "../executor.js";
import type { LedgerEntry } from "../port/model.js";
import type { SourceLimits } from "../source.js";
import type { TeamOutcome, TeamStateType } from "../team/state.js";
import { archive } from "./archive.js";
import {
	refOf,
	type StageIdentity,
	type StageManifest,
	StageRefusedError,
	stageFormat,
	verdictFor,
} from "./manifest.js";

export interface StageOptions {
	/** The stage directory inside the verdict tree. */
	dir: string;
	sidecar: SidecarClient;
	identity: StageIdentity;
	teamProfileDigest: Digest;
	observerIdentity: string;
	sourceLimits: SourceLimits;
	now?: () => Date;
	log?: (event: string, fields?: Record<string, unknown>) => void;
}

export interface SealInput {
	saver: SqliteSaver;
	threadId: string;
	checkpointId?: string;
	state: TeamStateType;
	outcome: TeamOutcome;
	roundResults: Map<number, RoundResult>;
	ledger: LedgerEntry[];
	evidence: Record<string, unknown>;
	/** Aborted when the launch is canceled: nothing is submitted after it. */
	signal?: AbortSignal;
}

export interface SealedStage {
	stageId: string;
	existing: boolean;
	resultDigest: string;
	verdict: string;
	failureCode: string;
	outputs: Array<{ class: string; digest: string; sizeBytes: string; handle: string }>;
	manifest: StageManifest;
	dir: string;
}

/** Seals the stage: snapshot, archives, manifest, uploads, result manifest, acceptance (and the same bytes once more, to record that acceptance is idempotent). */
export async function sealStage(o: StageOptions, input: SealInput): Promise<SealedStage> {
	const now = o.now ?? (() => new Date());
	const canceled = () => {
		if (input.signal?.aborted)
			throw new StageRefusedError("CANCELED", "the launch was canceled while sealing; nothing is submitted");
	};
	canceled();
	const dir = o.dir;
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	// 1. A consistent snapshot of the checkpoint database, taken by the
	// engine's online backup after the last write.
	const snapshotPath = path.join(dir, "checkpoints.sqlite");
	await input.saver.db.backup(snapshotPath);
	const snapshot = refOf(snapshotPath);
	// 2. The result round's sealed session and source (the pair sealed together by the executor).
	const resultRound = input.outcome.round !== undefined ? input.roundResults.get(input.outcome.round) : undefined;
	const stageEntries = ["checkpoints.sqlite"];
	let session: StageManifest["session"];
	if (resultRound?.sessionFile) {
		writeFileSync(path.join(dir, "session.jsonl"), readFileSync(resultRound.sessionFile), { mode: 0o400 });
		session = { round: resultRound.round, sealed: refOf(path.join(dir, "session.jsonl")) };
		stageEntries.push("session.jsonl");
	}
	let source: StageManifest["source"];
	if (resultRound?.source) {
		const files = resultRound.source.files.map((f) => f.path);
		const ref = await archive(path.join(dir, "source.tar"), path.join(resultRound.sealedDir, "source"), files);
		source = {
			round: resultRound.round,
			revision: resultRound.sourceRevision,
			manifestDigest: resultRound.source.manifestDigest,
			files: files.length,
			totalBytes: resultRound.source.totalBytes,
			archive: ref,
		};
	}
	const validation = input.state.validations.filter((v) => v.round === input.outcome.round).at(-1);
	const manifest: StageManifest = {
		schemaVersion: stageFormat,
		stageKind: "codegen-team",
		identity: o.identity,
		phaseOrdinal: sequence(input.state.rounds.length),
		teamProfileDigest: o.teamProfileDigest,
		checkpoint: { threadId: input.threadId, checkpointId: input.checkpointId, snapshot },
		session,
		source,
		validation: validation
			? {
					round: validation.round,
					status: validation.result.status,
					failureCode: "failureCode" in validation.result ? validation.result.failureCode : undefined,
					certificationDigest:
						"certification" in validation.result ? validation.result.certification?.digest : undefined,
				}
			: undefined,
		calls: input.ledger.map((l) => ({ callId: l.callId, role: l.role, outcome: l.outcome, code: l.code })),
		budget: input.state.budget,
		counters: {
			rounds: input.state.rounds.length,
			reviewRounds: input.state.reviewRounds,
			repairs: input.state.repairs,
		},
		outcome: input.outcome,
		sealedAt: now().toISOString(),
	};
	writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest, null, 2), { mode: 0o400 });
	stageEntries.push("manifest.json");
	// 3. The stage archive (checkpoint snapshot, session, manifest) and the evidence document.
	const stageRef = await archive(path.join(dir, "stage.tar"), dir, stageEntries);
	const evidenceBytes = Buffer.from(JSON.stringify({ ...input.evidence, stageManifest: manifest }, null, 2));
	writeFileSync(path.join(dir, "evidence.json"), evidenceBytes, { mode: 0o400 });
	// 4. The uploads: each a scoped transfer Control finalizes by bytes.
	const outputs: SealedStage["outputs"] = [];
	if (source) {
		canceled();
		const t = await o.sidecar.upload("source", "application/x-tar", readFileSync(path.join(dir, "source.tar")));
		if (t.digest !== source.archive.digest || t.sizeBytes !== source.archive.sizeBytes)
			throw new StageRefusedError(
				"OBSERVER_FAILED",
				"the source transfer verified other bytes than the sealed archive",
			);
		outputs.push({ class: "source", digest: t.digest, sizeBytes: t.sizeBytes, handle: t.handle });
	}
	canceled();
	const stageTransfer = await o.sidecar.upload("stage", "application/x-tar", readFileSync(path.join(dir, "stage.tar")));
	if (stageTransfer.digest !== stageRef.digest)
		throw new StageRefusedError("OBSERVER_FAILED", "the stage transfer verified other bytes than the sealed archive");
	outputs.push({
		class: "stage",
		digest: stageTransfer.digest,
		sizeBytes: stageTransfer.sizeBytes,
		handle: stageTransfer.handle,
	});
	canceled();
	const evidenceTransfer = await o.sidecar.upload("evidence", "application/json", evidenceBytes);
	outputs.push({
		class: "evidence",
		digest: evidenceTransfer.digest,
		sizeBytes: evidenceTransfer.sizeBytes,
		handle: evidenceTransfer.handle,
	});
	// 5. The result manifest of the jobs contract, validated, submitted, and submitted again.
	const { verdict, failureCode } = verdictFor(input.outcome);
	const result: Record<string, unknown> = {
		schemaVersion: 1,
		launchId: o.identity.launchId,
		attemptId: o.identity.attemptId,
		jobKind: o.identity.jobKind,
		profileId: o.identity.profileId,
		verdict,
		outputs,
		completedAt: now()
			.toISOString()
			.replace(/\.\d{3}Z$/, "Z"),
	};
	if (failureCode) result.failureCode = failureCode;
	const problem = validateAgainst("urn:anvilkit:jobs:v1#/$defs/resultManifest", result);
	if (problem) throw new StageRefusedError("OBSERVER_FAILED", `result manifest outside the jobs contract: ${problem}`);
	const resultBytes = Buffer.from(JSON.stringify(result));
	writeFileSync(path.join(dir, "result-manifest.json"), resultBytes, { mode: 0o400 });
	canceled();
	const stage = await o.sidecar.submit(verdict, failureCode, o.observerIdentity, resultBytes);
	const repeat = await o.sidecar.submit(verdict, failureCode, o.observerIdentity, resultBytes);
	if (!repeat.existing || repeat.stageId !== stage.stageId)
		throw new StageRefusedError("OBSERVER_FAILED", `the repeated submission did not reenter stage ${stage.stageId}`);
	o.log?.("stage sealed", { stageId: stage.stageId, verdict, failureCode, outputs: outputs.length });
	return {
		stageId: stage.stageId,
		existing: stage.existing,
		resultDigest: stage.resultDigest,
		verdict,
		failureCode,
		outputs,
		manifest,
		dir,
	};
}
