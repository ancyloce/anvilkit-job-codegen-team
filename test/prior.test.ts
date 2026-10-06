import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import * as tar from "tar";
import { afterEach, describe, expect, it } from "vitest";
import type { AcceptedStage, Scope } from "../src/adapters/sidecar.js";
import { type Digest, sequence, sha256 } from "../src/digest.js";
import { inventory, readTree } from "../src/source.js";
import { type StageManifest, StageRefusedError, stageFormat } from "../src/stage/manifest.js";
import { importPrior } from "../src/stage/proof.js";

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
