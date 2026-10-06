// Recovery proofs (DD-03 §3): Control's accepted stage is the authority, and
// nothing local or loaded is trusted until it is proven to be exactly what
// that stage binds — the result manifest by its digest, every output by
// class, digest, size and object version, the joint manifest by its digest
// inside the bound stage archive, the checkpoint snapshot, session and
// source by the manifest — and the manifest by its format, identity, epochs
// and team profile. A mixed, missing, altered, stale or incompatible object
// returns nothing to build on (STALE_STAGE).
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { AcceptedStage, Scope } from "../adapters/sidecar.js";
import { type Digest, sequence, sha256 } from "../digest.js";
import { inventory, readTree, type SourceLimits } from "../source.js";
import { tarInventory, tarMembers, unpackTar } from "./archive.js";
import { boundManifest, refOf, type StageManifest, StageRefusedError } from "./manifest.js";

export interface ProvenStage {
	accepted: AcceptedStage;
	manifest: StageManifest;
	resultManifest: Record<string, unknown>;
}

/** Proves the local stage directory against Control's accepted stage of this attempt. */
export async function proveStage(
	dir: string,
	accepted: AcceptedStage,
	scope: Scope,
	teamProfileDigest: Digest,
): Promise<ProvenStage> {
	const refuse = (what: string) => new StageRefusedError("STALE_STAGE", `accepted stage ${accepted.stageId}: ${what}`);
	if (accepted.attemptId !== scope.attemptId)
		throw refuse(`belongs to attempt ${accepted.attemptId}, this scope is ${scope.attemptId}`);
	if (accepted.executionEpoch !== scope.executionEpoch || accepted.recoveryEpoch !== scope.recoveryEpoch)
		throw refuse(
			`was accepted under epochs ${accepted.executionEpoch}/${accepted.recoveryEpoch}, the scope is at ${scope.executionEpoch}/${scope.recoveryEpoch}`,
		);
	const resultPath = path.join(dir, "result-manifest.json");
	if (!existsSync(resultPath)) throw refuse("no local result manifest");
	const resultBytes = readFileSync(resultPath);
	if (sha256(resultBytes) !== accepted.resultDigest)
		throw refuse(
			`the local result manifest (${sha256(resultBytes)}) is not the accepted one (${accepted.resultDigest})`,
		);
	const resultManifest = JSON.parse(resultBytes.toString("utf8")) as {
		verdict: string;
		outputs: Array<{ class: string; digest: string; sizeBytes: string; handle: string }>;
	};
	if (resultManifest.verdict !== accepted.verdict)
		throw refuse(`the local result manifest states ${resultManifest.verdict}, Control accepted ${accepted.verdict}`);
	const localObject: Record<string, string> = { source: "source.tar", stage: "stage.tar", evidence: "evidence.json" };
	if (resultManifest.outputs.length !== accepted.artifacts.length)
		throw refuse("the accepted stage binds another number of artifacts than the local manifest names");
	for (const out of resultManifest.outputs) {
		const art = accepted.artifacts.find((a) => a.handle === out.handle);
		if (!art) throw refuse(`output ${out.class} ${out.handle} is not bound by the accepted stage`);
		if (art.class !== out.class || art.digest !== out.digest || art.sizeBytes !== out.sizeBytes)
			throw refuse(`output ${out.class} differs from the bound artifact (${art.class} ${art.digest} ${art.sizeBytes})`);
		if (!art.objectVersion) throw refuse(`artifact ${out.handle} carries no object version`);
		const file = localObject[out.class];
		if (!file) throw refuse(`output class ${out.class} has no local object`);
		const local = path.join(dir, file);
		if (!existsSync(local)) throw refuse(`local object ${file} is missing`);
		const bytes = readFileSync(local);
		if (sha256(bytes) !== art.digest || sequence(bytes.length) !== art.sizeBytes)
			throw refuse(`local object ${file} does not hash to the bound artifact`);
	}
	// The joint manifest binds the objects inside the stage archive to each
	// other — and the local copy of it is trusted only as the bytes the
	// accepted stage archive holds: the archive's digest is bound by Control,
	// the manifest inside it by the archive, so an outcome, budget or counter
	// edited locally is not the accepted one.
	const manifestPath = path.join(dir, "manifest.json");
	if (!existsSync(manifestPath)) throw refuse("the local stage manifest is missing");
	const manifestBytes = readFileSync(manifestPath);
	const stageArchive = path.join(dir, "stage.tar");
	if (!existsSync(stageArchive)) throw refuse("the local stage archive is missing");
	const inside = await tarInventory(stageArchive);
	if (inside.get("manifest.json") !== sha256(manifestBytes))
		throw refuse("the local stage manifest is not the one the accepted stage archive holds");
	const manifest = boundManifest(manifestBytes, scope, teamProfileDigest, refuse);
	const snapshot = path.join(dir, "checkpoints.sqlite");
	if (!existsSync(snapshot)) throw refuse("the checkpoint snapshot is missing");
	const snapRef = refOf(snapshot);
	if (
		snapRef.digest !== manifest.checkpoint.snapshot.digest ||
		snapRef.sizeBytes !== manifest.checkpoint.snapshot.sizeBytes
	)
		throw refuse("the checkpoint snapshot is not the one the stage manifest binds");
	if (manifest.session) {
		const sessionPath = path.join(dir, "session.jsonl");
		if (!existsSync(sessionPath)) throw refuse("the sealed session is missing");
		const s = refOf(sessionPath);
		if (s.digest !== manifest.session.sealed.digest || s.sizeBytes !== manifest.session.sealed.sizeBytes)
			throw refuse("the sealed session is not the one the stage manifest binds");
	}
	if (manifest.source) {
		const sourceTar = path.join(dir, "source.tar");
		if (!existsSync(sourceTar)) throw refuse("the source archive is missing");
		const s = refOf(sourceTar);
		if (s.digest !== manifest.source.archive.digest)
			throw refuse("the source archive is not the one the stage manifest binds");
		const bound = accepted.artifacts.find((a) => a.class === "source");
		if (!bound || bound.digest !== s.digest) throw refuse("the accepted stage binds another source archive");
	}
	// The archived stage must contain exactly the objects the manifest binds (a mixed archive is refused).
	const expectMembers = ["checkpoints.sqlite", "manifest.json", ...(manifest.session ? ["session.jsonl"] : [])].sort();
	if (JSON.stringify([...inside.keys()].sort()) !== JSON.stringify(expectMembers))
		throw refuse(
			`the stage archive holds ${[...inside.keys()].join(", ")}, the manifest binds ${expectMembers.join(", ")}`,
		);
	if (inside.get("checkpoints.sqlite") !== snapRef.digest)
		throw refuse("the checkpoint inside the stage archive differs from the local snapshot");
	if (manifest.session && inside.get("session.jsonl") !== manifest.session.sealed.digest)
		throw refuse("the session inside the stage archive differs from the sealed session");
	return { accepted, manifest, resultManifest: resultManifest as unknown as Record<string, unknown> };
}

/** Recomputes the sealed source of a proven boundary from its extracted copy and compares it with the manifest. */
export function verifySealedSource(
	sealedDir: string,
	manifest: StageManifest,
	limits: SourceLimits,
): string | undefined {
	if (!manifest.source) return "the stage binds no source";
	let files: Map<string, Buffer>;
	try {
		files = readTree(sealedDir, limits);
	} catch (err) {
		return (err as Error).message;
	}
	const got = inventory(files);
	if (got.manifestDigest !== manifest.source.manifestDigest)
		return `manifest digest ${got.manifestDigest} is not the bound ${manifest.source.manifestDigest}`;
	if (got.files.length !== manifest.source.files) return "file count differs";
	return undefined;
}

/**
 * The proven boundary of a prior attempt (P13-04 cross-attempt recovery):
 * the accepted stage Control recorded for that attempt of the same
 * operation, the objects the launch inputs carried (the stage archive and
 * the source archive the sidecar loaded through Control) proven against
 * it, the joint manifest read from inside the stage archive, and the
 * sealed source unpacked as the tree the repair continues from.
 */
export interface PriorBoundary {
	accepted: AcceptedStage;
	manifest: StageManifest;
	sourceRevision: string;
	files: string[];
}

export interface PriorInputs {
	/** The stage archive bytes (the `stage` input). */
	stage: Buffer;
	/** The source archive bytes (the `source` input). */
	source: Buffer;
	/** The launch envelope's digests of the two inputs. */
	stageDigest: Digest;
	sourceDigest: Digest;
}

/**
 * Proves the prior attempt's objects against Control's accepted stage and
 * unpacks the sealed source into sourceDir. Refuses (STALE_STAGE) an
 * archive the accepted stage does not bind, a manifest of another format,
 * operation, attempt, epoch or team profile, a source whose recomputed
 * manifest digest differs, and any archive entry that is not a regular
 * file under a normalized relative path.
 */
export async function importPrior(
	inputs: PriorInputs,
	accepted: AcceptedStage,
	scope: Scope,
	teamProfileDigest: Digest,
	sourceDir: string,
	sourceLimits: SourceLimits,
): Promise<PriorBoundary> {
	const refuse = (what: string) => new StageRefusedError("STALE_STAGE", `prior stage ${accepted.stageId}: ${what}`);
	if (sha256(inputs.stage) !== inputs.stageDigest || sha256(inputs.source) !== inputs.sourceDigest)
		throw refuse("the loaded inputs do not hash to the launch envelope's digests");
	const boundStage = accepted.artifacts.find((a) => a.class === "stage");
	const boundSource = accepted.artifacts.find((a) => a.class === "source");
	if (!boundStage || boundStage.digest !== inputs.stageDigest || boundStage.sizeBytes !== sequence(inputs.stage.length))
		throw refuse("the accepted stage binds another stage archive");
	if (
		!boundSource ||
		boundSource.digest !== inputs.sourceDigest ||
		boundSource.sizeBytes !== sequence(inputs.source.length)
	)
		throw refuse("the accepted stage binds another source archive");
	if (accepted.executionEpoch !== scope.executionEpoch || accepted.recoveryEpoch !== scope.recoveryEpoch)
		throw refuse(
			`was accepted under epochs ${accepted.executionEpoch}/${accepted.recoveryEpoch}, the scope is at ${scope.executionEpoch}/${scope.recoveryEpoch}`,
		);
	const members = await tarMembers(inputs.stage);
	const manifestBytes = members.get("manifest.json");
	if (!manifestBytes) throw refuse("the stage archive holds no manifest");
	const manifest = boundManifest(
		manifestBytes,
		{
			operationId: scope.operationId,
			attemptId: accepted.attemptId,
			executionEpoch: scope.executionEpoch,
			recoveryEpoch: scope.recoveryEpoch,
		},
		teamProfileDigest,
		refuse,
	);
	if (!manifest.source) throw refuse("the stage binds no source");
	if (manifest.source.archive.digest !== inputs.sourceDigest)
		throw refuse("the source archive is not the one the stage manifest binds");
	const files = await unpackTar(inputs.source, sourceDir, sourceLimits);
	const got = inventory(readTree(sourceDir, sourceLimits));
	if (got.manifestDigest !== manifest.source.manifestDigest || got.files.length !== manifest.source.files)
		throw refuse(
			`the unpacked source (${got.manifestDigest}, ${got.files.length} files) is not the sealed source the manifest binds`,
		);
	return { accepted, manifest, sourceRevision: manifest.source.revision, files };
}
