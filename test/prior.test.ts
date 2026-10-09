import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import * as tar from "tar";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AcceptedStage, Scope } from "../src/adapters/sidecar.js";
import { zeroBudget } from "../src/budget.js";
import { teamProfileDigest } from "../src/coordinator/inputs.js";
import { type Digest, sequence, sha256 } from "../src/digest.js";
import type { CandidateRunner } from "../src/executor.js";
import { inventory, readTree } from "../src/source.js";
import { archive, tarMembers } from "../src/stage/archive.js";
import { type StageManifest, StageRefusedError, stageFormat } from "../src/stage/manifest.js";
import { importPrior } from "../src/stage/proof.js";
import { loadPrompts } from "../src/team/roles.js";
import { FakeSidecar, type Matcher } from "./doubles.js";
import {
	candidateEnded,
	coordinatorTeamYaml,
	heroFixture,
	localRunner,
	packageRoot,
	rootTestsRequired,
	rootTestsUnavailable,
	runCoordinator,
	teamScript,
	uidRunner,
} from "./helpers.js";

const limits = { maxFiles: 32, maxFileBytes: 65536, maxTotalBytes: 262144, maxSessionBytes: 65536 };

async function tarOf(cwd: string, entries: string[], file: string): Promise<Buffer> {
	await tar.create(
		{ portable: true, mtime: new Date("1985-10-26T08:15:00.000Z"), cwd, noDirRecurse: true, file, follow: false },
		entries.sort(),
	);
	return readFileSync(file);
}

describe("the prior accepted boundary of a repair attempt (P13-04)", () => {
	const dirs: string[] = [];
	const scratch = () => {
		const d = mkdtempSync(path.join(tmpdir(), "anvilkit-prior-"));
		dirs.push(d);
		return d;
	};
	afterEach(() => {
		for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
	});

	async function fixture(format: number = stageFormat) {
		const root = scratch();
		const src = path.join(root, "source");
		mkdirSync(path.join(src, "src"), { recursive: true });
		writeFileSync(path.join(src, "package.json"), '{"name":"@acme/hero","version":"0.1.0"}');
		writeFileSync(path.join(src, "src", "Hero.tsx"), "export const Hero = () => null;");
		const inv = inventory(readTree(src, limits));
		const source = await tarOf(src, ["package.json", "src/Hero.tsx"], path.join(root, "source.tar"));
		const scope: Scope = {
			tenantId: "tenant_a",
			operationId: "op_1",
			attemptId: "att_2",
			instanceId: "inst_2",
			current: true,
			profileId: "codegen-team-dev-v1",
			executionEpoch: "1",
			recoveryEpoch: "1",
			launchKey: "gen-c-2",
			deadline: new Date(Date.now() + 3_600_000).toISOString(),
		} as Scope;
		const manifest: StageManifest = {
			schemaVersion: format as typeof stageFormat,
			stageKind: "codegen-team",
			identity: {
				launchId: "lch_1",
				launchKey: "gen-c-1",
				tenantId: "tenant_a",
				operationId: "op_1",
				attemptId: "att_1",
				instanceId: "inst_1",
				profileId: "codegen-team-dev-v1",
				profileRevision: "1",
				jobKind: "codegen",
				executionEpoch: "1",
				recoveryEpoch: "1",
				launchEpoch: "1",
				deadline: scope.deadline,
			},
			phaseOrdinal: "1",
			teamProfileDigest: "sha256:team" as Digest,
			checkpoint: { threadId: "att_1", snapshot: { digest: "sha256:snap" as Digest, sizeBytes: "1" } },
			source: {
				round: 1,
				revision: "1",
				manifestDigest: inv.manifestDigest,
				files: 2,
				totalBytes: 60,
				archive: { digest: sha256(source), sizeBytes: sequence(source.length) },
			},
			calls: [],
			budget: {} as StageManifest["budget"],
			counters: { rounds: 1, reviewRounds: 1, repairs: 0 },
			outcome: { kind: "certified", detail: "" },
			sealedAt: "2026-09-17T00:00:00Z",
		};
		const stageDir = path.join(root, "stage");
		mkdirSync(stageDir);
		writeFileSync(path.join(stageDir, "manifest.json"), JSON.stringify(manifest));
		writeFileSync(path.join(stageDir, "checkpoints.sqlite"), "x");
		const stage = await tarOf(stageDir, ["manifest.json", "checkpoints.sqlite"], path.join(root, "stage.tar"));
		const accepted: AcceptedStage = {
			stageId: "stg_1",
			attemptId: "att_1",
			instanceId: "inst_1",
			verdict: "certified",
			resultDigest: "sha256:r",
			observerIdentity: "team",
			profileId: "codegen-team-dev-v1",
			executionEpoch: "1",
			recoveryEpoch: "1",
			artifacts: [
				{
					handle: "h_stage",
					class: "stage",
					digest: sha256(stage),
					sizeBytes: sequence(stage.length),
					transferId: "x1",
					objectVersion: "v1",
				},
				{
					handle: "h_source",
					class: "source",
					digest: sha256(source),
					sizeBytes: sequence(source.length),
					transferId: "x2",
					objectVersion: "v1",
				},
			],
		} as AcceptedStage;
		return { root, stage, source, scope, accepted, manifest };
	}

	it("proves the loaded archives against Control's accepted stage and unpacks the sealed source", async () => {
		const f = await fixture();
		const out = path.join(f.root, "w", "source");
		const boundary = await importPrior(
			{ stage: f.stage, source: f.source, stageDigest: sha256(f.stage), sourceDigest: sha256(f.source) },
			f.accepted,
			f.scope,
			"sha256:team" as Digest,
			out,
			limits,
		);
		expect(boundary.sourceRevision).toBe("1");
		expect(boundary.files).toEqual(["package.json", "src/Hero.tsx"]);
		expect(boundary.manifest.identity.attemptId).toBe("att_1");
	});

	it("refuses an archive the accepted stage does not bind, another operation or profile, and an altered source", async () => {
		const f = await fixture();
		const other = {
			...f.accepted,
			artifacts: f.accepted.artifacts.map((a) => (a.class === "source" ? { ...a, digest: "sha256:other" } : a)),
		} as AcceptedStage;
		await expect(
			importPrior(
				{ stage: f.stage, source: f.source, stageDigest: sha256(f.stage), sourceDigest: sha256(f.source) },
				other,
				f.scope,
				"sha256:team" as Digest,
				path.join(f.root, "o1"),
				limits,
			),
		).rejects.toBeInstanceOf(StageRefusedError);
		const foreign = { ...f.scope, operationId: "op_9" } as Scope;
		await expect(
			importPrior(
				{ stage: f.stage, source: f.source, stageDigest: sha256(f.stage), sourceDigest: sha256(f.source) },
				f.accepted,
				foreign,
				"sha256:team" as Digest,
				path.join(f.root, "o2"),
				limits,
			),
		).rejects.toBeInstanceOf(StageRefusedError);
		await expect(
			importPrior(
				{ stage: f.stage, source: f.source, stageDigest: sha256(f.stage), sourceDigest: sha256(f.source) },
				f.accepted,
				f.scope,
				"sha256:otherteam" as Digest,
				path.join(f.root, "o3"),
				limits,
			),
		).rejects.toBeInstanceOf(StageRefusedError);
		const altered = Buffer.concat([f.source, Buffer.alloc(512)]);
		await expect(
			importPrior(
				{ stage: f.stage, source: altered, stageDigest: sha256(f.stage), sourceDigest: sha256(f.source) },
				f.accepted,
				f.scope,
				"sha256:team" as Digest,
				path.join(f.root, "o4"),
				limits,
			),
		).rejects.toBeInstanceOf(StageRefusedError);
		const epoch = { ...f.scope, executionEpoch: "2" } as Scope;
		await expect(
			importPrior(
				{ stage: f.stage, source: f.source, stageDigest: sha256(f.stage), sourceDigest: sha256(f.source) },
				f.accepted,
				epoch,
				"sha256:team" as Digest,
				path.join(f.root, "o5"),
				limits,
			),
		).rejects.toBeInstanceOf(StageRefusedError);
	});
	it("refuses a stage of another manifest format (the accounting before the per-send exposure) instead of reading it as this one", async () => {
		const f = await fixture(1);
		await expect(
			importPrior(
				{ stage: f.stage, source: f.source, stageDigest: sha256(f.stage), sourceDigest: sha256(f.source) },
				f.accepted,
				f.scope,
				"sha256:team" as Digest,
				path.join(f.root, "o6"),
				limits,
			),
		).rejects.toThrow(/format 1, this build reads 2/);
	});
});

// A repair launch end to end (P13-04 → P0.8 AC3): Control's accepted stage
// of the prior attempt classified its source repairable; this attempt's
// coordinator proves the loaded archives, unpacks the source into its
// read-only prior tree, and the repair round's coder copies it into its own
// source directory, edits it and the new revision is sealed — a different
// source digest — while the prior tree keeps the proven bytes.
const sourceLimits = { maxFiles: 256, maxFileBytes: 1 << 20, maxTotalBytes: 16 << 20 };

async function priorLaunch(root: string, sidecar: FakeSidecar, teamYaml: string) {
	const files = readTree(heroFixture, sourceLimits);
	const inv = inventory(files);
	const sourceRef = await archive(path.join(root, "prior-source.tar"), heroFixture, [...files.keys()]);
	const source = readFileSync(path.join(root, "prior-source.tar"));
	const scope = sidecar.scope as Record<string, string>;
	const prompts = loadPrompts(path.join(packageRoot, "agent"));
	const toolsText = readFileSync(path.join(packageRoot, "agent", "team", "tools.json"), "utf8");
	const manifest: StageManifest = {
		schemaVersion: stageFormat,
		stageKind: "codegen-team",
		identity: {
			launchId: "launch_prior",
			launchKey: "hp-team-prior",
			tenantId: scope.tenantId as string,
			operationId: scope.operationId as string,
			attemptId: "att_prior",
			instanceId: "inst_prior",
			profileId: scope.profileId as string,
			profileRevision: "2",
			jobKind: "codegen",
			executionEpoch: scope.executionEpoch as string,
			recoveryEpoch: scope.recoveryEpoch as string,
			launchEpoch: "1",
			deadline: scope.deadline as string,
		},
		phaseOrdinal: "1",
		teamProfileDigest: teamProfileDigest(teamYaml, prompts, toolsText),
		checkpoint: { threadId: "att_prior", snapshot: { digest: sha256(Buffer.from("x")), sizeBytes: "1" } },
		source: {
			round: 1,
			revision: "1",
			manifestDigest: inv.manifestDigest,
			files: inv.files.length,
			totalBytes: inv.totalBytes,
			archive: sourceRef,
		},
		calls: [],
		budget: zeroBudget(),
		counters: { rounds: 1, reviewRounds: 1, repairs: 0 },
		outcome: {
			kind: "repairable",
			failureCode: "CANDIDATE_TEST_FAILED",
			detail: "the counter did not advance",
			round: 1,
		},
		sealedAt: "2026-10-08T00:00:00Z",
	};
	const stageDir = path.join(root, "prior-stage");
	mkdirSync(stageDir);
	writeFileSync(path.join(stageDir, "manifest.json"), JSON.stringify(manifest));
	writeFileSync(path.join(stageDir, "checkpoints.sqlite"), "x");
	const stageRef = await archive(path.join(root, "prior-stage.tar"), stageDir, ["checkpoints.sqlite", "manifest.json"]);
	const stage = readFileSync(path.join(root, "prior-stage.tar"));
	sidecar.priorStages.set("att_prior", {
		stageId: "stage-prior",
		attemptId: "att_prior",
		instanceId: "inst_prior",
		verdict: "repairable",
		failureCode: "CANDIDATE_TEST_FAILED",
		resultDigest: sha256(Buffer.from("prior result")),
		observerIdentity: "anvilkit-codegen-team",
		profileId: scope.profileId as string,
		executionEpoch: scope.executionEpoch as string,
		recoveryEpoch: scope.recoveryEpoch as string,
		artifacts: [
			{ handle: "h-prior-stage", class: "stage", ...stageRef, transferId: "t-1", objectVersion: "v1" },
			{ handle: "h-prior-source", class: "source", ...sourceRef, transferId: "t-2", objectVersion: "v1" },
		],
	});
	const evidence = Buffer.from(
		JSON.stringify({
			certification: {
				verdict: "repairable",
				failureCode: "CANDIDATE_TEST_FAILED",
				checks: [{ name: "browser-interaction", status: "fail", detail: "the counter did not advance" }],
			},
		}),
	);
	return { inputs: { stage, source, evidence }, manifestDigest: inv.manifestDigest, archiveDigest: sourceRef.digest };
}

/** The repair round's coder: one edit of a file of the prior source, then done. */
const repairCoder: Matcher = (req) =>
	req.messages.some((m) => m.role === "assistant" && m.toolCalls?.some((t) => t.name === "edit"))
		? { text: ["Repaired."] }
		: {
				text: ["Repairing the stylesheet."],
				tools: [
					{
						id: "tc_fix",
						name: "edit",
						arguments: JSON.stringify({
							path: "styles/hero.css",
							edits: [{ oldText: ".ak-hero {", newText: ".ak-hero { /* repaired */" }],
						}),
					},
				],
			};

async function repairLaunch(root: string, sidecar: FakeSidecar, coder: CandidateRunner, workspaceMode?: number) {
	const prior = await priorLaunch(root, sidecar, coordinatorTeamYaml);
	sidecar.script = teamScript({ coder: repairCoder });
	const run = await runCoordinator({
		sidecar,
		root,
		inputs: prior.inputs,
		workspaceMode,
		supervisor: async (req) =>
			candidateEnded(req, await coder.run({ round: req.round as number, roundDir: req.roundDir as string })),
	});
	expect(run.code, run.log).toBe(0);
	// One repair round after the imported one, at the next revision, prompted with the validator's classification.
	expect(run.requests.map((q) => q.round)).toEqual([2]);
	expect(run.result.counters).toEqual({ rounds: 2, reviewRounds: 2, repairs: 1 });
	const coderCall = sidecar.requests.find((q) => q.callId.includes(":coder:"));
	expect(coderCall?.messages.at(-1)?.content).toContain("CANDIDATE_TEST_FAILED");
	// The sealed stage binds the repaired revision: another source digest than the prior one.
	const stage = sidecar.transfers.find((t) => t.class === "stage");
	const manifest = JSON.parse(String((await tarMembers(stage?.body ?? Buffer.alloc(0))).get("manifest.json")));
	expect(manifest.source).toMatchObject({ round: 2, revision: "2" });
	expect(manifest.source.manifestDigest).not.toBe(prior.manifestDigest);
	const source = sidecar.transfers.find((t) => t.class === "source");
	expect(source?.digest).not.toBe(prior.archiveDigest);
	const sealed = await tarMembers(source?.body ?? Buffer.alloc(0));
	expect(String(sealed.get("styles/hero.css"))).toContain(".ak-hero { /* repaired */");
	// The coder wrote its own copy; the trusted prior tree keeps the proven bytes, owned by the trusted side.
	const workspace = path.join(root, "workspace");
	const priorCss = path.join(workspace, "prior", "source", "styles", "hero.css");
	expect(readFileSync(priorCss, "utf8")).not.toContain("repaired");
	expect(statSync(priorCss).uid).toBe(process.getuid?.());
	expect(statSync(path.join(workspace, "prior")).mode & 0o022).toBe(0);
	return { workspace, ownCss: path.join(workspace, "w", "source", "styles", "hero.css") };
}

describe("a repair launch repairs the prior source as the coder's own copy (P0.8 AC3)", () => {
	let sidecar: FakeSidecar;
	let root: string;
	beforeEach(async () => {
		sidecar = new FakeSidecar("prior");
		await sidecar.start();
		root = mkdtempSync(path.join(tmpdir(), "prior-launch-"));
	});
	afterEach(async () => {
		await sidecar.stop();
		rmSync(root, { recursive: true, force: true });
	});

	it("the coder (the test's own user) edits its copy of the prior tree and the sealed stage binds the new revision", async () => {
		const { ownCss } = await repairLaunch(root, sidecar, localRunner());
		expect(readFileSync(ownCss, "utf8")).toContain("/* repaired */");
	});
});

const rootSkip = rootTestsUnavailable();

describe.runIf(rootTestsRequired && rootSkip !== "")("root tests", () => {
	it("are required (ANVILKIT_REQUIRE_ROOT_TESTS) and can run here", () => {
		throw new Error(`ANVILKIT_REQUIRE_ROOT_TESTS is set: ${rootSkip}`);
	});
});

describe.skipIf(rootSkip !== "")("a repair launch under the real UID split (root: the coder runs as UID 10001)", () => {
	let sidecar: FakeSidecar;
	let root: string;
	beforeEach(async () => {
		// Under /tmp, not the caller's TMPDIR: the candidate identity connects to
		// the candidate socket and traverses the launch's tree.
		sidecar = new FakeSidecar("prior-uid", "/tmp");
		await sidecar.start();
		chmodSync(sidecar.candidateSocket, 0o777);
		root = mkdtempSync(path.join("/tmp", "prior-uid-"));
		chmodSync(root, 0o755);
	});
	afterEach(async () => {
		await sidecar.stop();
		rmSync(root, { recursive: true, force: true });
	});

	it("a repairable verdict followed by a repair round: the coder's write to the prior source succeeds and the sealed source digest differs", async () => {
		const stage = path.join(root, "stage");
		mkdirSync(stage, { mode: 0o755 });
		const workspace = path.join(root, "workspace");
		const coder = uidRunner({ stage, home: path.join(workspace, "w") });
		// The workspace is an emptyDir (world-writable): the coder creates and owns w/.
		const { ownCss } = await repairLaunch(root, sidecar, coder, 0o777);
		expect(readFileSync(ownCss, "utf8")).toContain("/* repaired */");
		expect(statSync(ownCss).uid).toBe(10001);
		expect(statSync(path.join(workspace, "w")).uid).toBe(10001);
		expect(existsSync(path.join(workspace, "w", "session"))).toBe(true);
	});
});
