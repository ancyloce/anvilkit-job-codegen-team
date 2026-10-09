import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import * as tar from "tar";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Scope, SidecarClient } from "../src/adapters/sidecar.js";
import { zeroBudget } from "../src/budget.js";
import { sha256 } from "../src/digest.js";
import type { RoundResult } from "../src/executor.js";
import type { LedgerEntry } from "../src/port/model.js";
import { sealSource } from "../src/source.js";
import { stageArchiveMember, tarInventory } from "../src/stage/archive.js";
import { type StageIdentity, StageRefusedError, verdictFor } from "../src/stage/manifest.js";
import { verifySealedSource } from "../src/stage/proof.js";
import { StageStore } from "../src/stage/store.js";
import type { TeamOutcome, TeamStateType } from "../src/team/state.js";
import { FakeSidecar } from "./doubles.js";
import { heroFixture } from "./helpers.js";

describe("StageStore", () => {
	let sidecar: FakeSidecar;
	let root: string;
	let saver: SqliteSaver;
	const identity: StageIdentity = {
		launchId: "launch_team",
		launchKey: "hp-team",
		tenantId: "tenant_a",
		operationId: "op_team",
		attemptId: "att_team",
		instanceId: "inst_team",
		profileId: "harness-wiring-dev-v1",
		profileRevision: "2",
		jobKind: "codegen",
		executionEpoch: "1",
		recoveryEpoch: "0",
		launchEpoch: "1",
		deadline: new Date(Date.now() + 600_000).toISOString(),
	};
	const scope = (): Scope => ({ ...sidecar.scope }) as unknown as Scope;
	const profileDigest = sha256("team-profile");
	beforeEach(async () => {
		sidecar = new FakeSidecar("stage");
		await sidecar.start();
		root = mkdtempSync(path.join(tmpdir(), "stage-"));
		saver = SqliteSaver.fromConnString(path.join(root, "checkpoints.sqlite"));
		await saver.put(
			{ configurable: { thread_id: "att_team", checkpoint_ns: "" } },
			{
				v: 1,
				id: "cp-1",
				ts: new Date().toISOString(),
				channel_values: { n: 1 },
				channel_versions: {},
				versions_seen: {},
			},
			{ source: "loop", step: 1, parents: {} },
		);
	});
	afterEach(async () => {
		saver.db.close();
		await sidecar.stop();
		rmSync(root, { recursive: true, force: true });
	});

	function store(dir = path.join(root, "stage")) {
		return new StageStore({
			dir,
			sidecar: new SidecarClient(sidecar.trustedSocket),
			identity,
			teamProfileDigest: profileDigest,
			observerIdentity: "anvilkit-codegen-team",
			sourceLimits: { maxFiles: 256, maxFileBytes: 1 << 20, maxTotalBytes: 16 << 20 },
		});
	}

	function sealedRound(): RoundResult {
		const sealedDir = path.join(root, "rounds", "1");
		const source = sealSource(heroFixture, path.join(sealedDir, "source"), {
			maxFiles: 256,
			maxFileBytes: 1 << 20,
			maxTotalBytes: 16 << 20,
		});
		const session = path.join(sealedDir, "session.jsonl");
		writeFileSync(
			session,
			'{"type":"session","id":"s1"}\n{"type":"message","message":{"role":"assistant","usage":{"input":1,"output":2}}}\n',
		);
		return {
			round: 1,
			kind: "code",
			sourceRevision: "1",
			sealedDir,
			source,
			sessionFile: session,
			sessionDigest: sha256(readFileSync(session)),
			report: { exit: 0, stop: "exited", descendantsStopped: 0, startedAt: "", endedAt: "" },
		};
	}

	function state(outcome: TeamOutcome): TeamStateType {
		return {
			brief: { componentId: "c", puckType: "Hero", packageName: "p", version: "1.0.0", requirements: "" },
			sourceRevision: "1",
			plan: undefined,
			retrieval: undefined,
			rounds: [{ round: 1, kind: "code", sourceRevision: "1", sealedDir: "", calls: 9, stop: "exited" }],
			reviews: [],
			reviewRounds: 1,
			repairs: 0,
			validations: [
				{
					round: 1,
					sourceRevision: "1",
					manifestDigest: "",
					result: {
						status: "certified",
						certification: {
							verdict: "certified",
							complete: true,
							checks: [],
							bindings: {},
							digest: "sha256:c",
							dir: "",
						},
					},
				},
			],
			budget: zeroBudget(),
			outcome,
		} as unknown as TeamStateType;
	}
	const ledger: LedgerEntry[] = [
		{
			callId: "att_team:planner:1",
			role: "planner",
			outcome: "succeeded",
			exposure: { currency: "USD", amount: "1" },
			frames: 3,
			reentered: false,
			at: "",
		},
	];
	const certified: TeamOutcome = { kind: "certified", detail: "ok", round: 1 };

	it("seals the joint stage: consistent snapshot, sealed session and source, manifest, three verified transfers, one accepted result reentered once", async () => {
		const round = sealedRound();
		const s = store();
		const sealed = await s.seal({
			saver,
			threadId: "att_team",
			checkpointId: "cp-1",
			state: state(certified),
			outcome: certified,
			roundResults: new Map([[1, round]]),
			ledger,
			evidence: { note: "test" },
		});
		expect(sealed.stageId).toBe("stage-1");
		expect(sealed.verdict).toBe("certified");
		expect(sealed.outputs.map((o) => o.class)).toEqual(["source", "stage", "evidence"]);
		expect(sidecar.results).toHaveLength(1);
		expect(sidecar.transfers.map((t) => t.class)).toEqual(["source", "stage", "evidence"]);
		const m = sealed.manifest;
		expect(m.identity).toEqual(identity);
		expect(m.source?.manifestDigest).toBe(round.source?.manifestDigest);
		expect(m.session?.sealed.digest).toBe(round.sessionDigest);
		expect(m.checkpoint.snapshot.digest).toBe(sha256(readFileSync(path.join(s.dir, "checkpoints.sqlite"))));
		expect(m.calls).toEqual([{ callId: "att_team:planner:1", role: "planner", outcome: "succeeded", code: undefined }]);
		const inside = await tarInventory(path.join(s.dir, "stage.tar"));
		expect([...inside.keys()].sort()).toEqual(["checkpoints.sqlite", "manifest.json", "session.jsonl"]);
		const sourceMembers = await tarInventory(path.join(s.dir, "source.tar"));
		expect([...sourceMembers.keys()].sort()).toEqual(round.source?.files.map((f) => f.path));
		// The snapshot is a usable checkpoint database holding the thread's checkpoint.
		const snap = SqliteSaver.fromConnString(path.join(s.dir, "checkpoints.sqlite"));
		const tuple = await snap.getTuple({ configurable: { thread_id: "att_team", checkpoint_ns: "" } });
		expect(tuple?.checkpoint.id).toBe("cp-1");
		snap.db.close();
		// Recovery: Control's accepted stage first, then every object proven.
		const proven = await s.recover(scope());
		expect(proven?.accepted.stageId).toBe("stage-1");
		expect(proven?.manifest.source?.manifestDigest).toBe(round.source?.manifestDigest);
		expect(
			verifySealedSource(path.join(round.sealedDir, "source"), proven?.manifest as never, {
				maxFiles: 256,
				maxFileBytes: 1048576,
				maxTotalBytes: 16777216,
			}),
		).toBeUndefined();
	});

	it("nothing accepted yet is no boundary; verdict mapping is fixed", async () => {
		expect(await store().recover(scope())).toBeUndefined();
		expect(verdictFor({ kind: "repairable", failureCode: "MISSING_CSS", detail: "" })).toEqual({
			verdict: "repairable",
			failureCode: "MISSING_CSS",
		});
		expect(verdictFor({ kind: "budget_exhausted", detail: "" })).toEqual({
			verdict: "infrastructure_failed",
			failureCode: "OBSERVER_FAILED",
		});
		expect(verdictFor({ kind: "deadline", detail: "" })).toEqual({
			verdict: "infrastructure_failed",
			failureCode: "DEADLINE_EXCEEDED",
		});
		expect(verdictFor({ kind: "canceled", detail: "" })).toEqual({ verdict: "canceled", failureCode: "CANCELED" });
	});

	it("refuses mixed, missing, altered and stale local state against the accepted stage", async () => {
		const round = sealedRound();
		const s = store();
		await s.seal({
			saver,
			threadId: "att_team",
			checkpointId: "cp-1",
			state: state(certified),
			outcome: certified,
			roundResults: new Map([[1, round]]),
			ledger,
			evidence: {},
		});
		const dir = s.dir;
		const keep = mkdtempSync(path.join(root, "keep-"));
		const objects = [
			"checkpoints.sqlite",
			"session.jsonl",
			"source.tar",
			"stage.tar",
			"evidence.json",
			"manifest.json",
			"result-manifest.json",
		];
		for (const f of objects) copyFileSync(path.join(dir, f), path.join(keep, f));
		// The sealed objects are read-only (0400) to their owner too: a caller other than root (whose DAC
		// override writes them in place) alters or restores one by replacing the file in the stage directory.
		const replace = (f: string, bytes: string | Buffer) => {
			rmSync(path.join(dir, f), { force: true });
			writeFileSync(path.join(dir, f), bytes);
		};
		const restore = () => {
			for (const f of objects) {
				rmSync(path.join(dir, f), { force: true });
				copyFileSync(path.join(keep, f), path.join(dir, f));
			}
		};
		const expectRefusal = async (what: string, pattern: RegExp) => {
			await expect(s.recover(scope()), what).rejects.toThrow(pattern);
			await expect(s.recover(scope()), what).rejects.toBeInstanceOf(StageRefusedError);
			restore();
		};
		// stale epochs
		sidecar.scope = { ...sidecar.scope, executionEpoch: "2" };
		await expectRefusal("stale epoch", /epochs 1\/0, the scope is at 2\/0/);
		sidecar.scope = { ...sidecar.scope, executionEpoch: "1" };
		// another attempt
		sidecar.scope = { ...sidecar.scope, attemptId: "att_other" };
		await expectRefusal("other attempt", /belongs to attempt att_team/);
		sidecar.scope = { ...sidecar.scope, attemptId: "att_team" };
		// missing object
		unlinkSync(path.join(dir, "source.tar"));
		await expectRefusal("missing source", /local object source.tar is missing/);
		// altered object (a different session sealed beside the same checkpoint: a mixed pair)
		replace("session.jsonl", "{}\n");
		await expectRefusal("mixed session", /sealed session is not the one the stage manifest binds/);
		// a checkpoint snapshot from another run
		replace("checkpoints.sqlite", Buffer.from("not the snapshot"));
		await expectRefusal("mixed checkpoint", /checkpoint snapshot is not the one/);
		// an altered evidence object (the digest no longer matches the bound artifact)
		replace("evidence.json", "{}");
		await expectRefusal("altered evidence", /does not hash to the bound artifact/);
		// a result manifest that is not the accepted one
		replace(
			"result-manifest.json",
			readFileSync(path.join(dir, "result-manifest.json")).toString().replace("certified", "repairable"),
		);
		await expectRefusal("other result", /is not the accepted one/);
		// the local manifest altered while every accepted artifact and archive is intact: its outcome, budget or
		// counters are not the ones the accepted stage archive holds, so nothing of it is a boundary
		const original = JSON.parse(readFileSync(path.join(dir, "manifest.json"), "utf8")) as Record<string, unknown>;
		for (const [what, patch] of [
			["outcome", { outcome: { kind: "certified", detail: "forged", round: 1 } }],
			["budget", { budget: { ...(original.budget as object), total: { calls: 99, exposure: "1" } } }],
			["counters", { counters: { rounds: 0, reviewRounds: 0, repairs: 0 } }],
		] as Array<[string, Record<string, unknown>]>) {
			replace("manifest.json", JSON.stringify({ ...original, ...patch }, null, 2));
			await expectRefusal(`altered manifest ${what}`, /manifest .*is not the one the accepted stage archive holds/);
		}
		// a stage sealed under another team profile
		const other = new StageStore({
			dir,
			sidecar: new SidecarClient(sidecar.trustedSocket),
			identity,
			teamProfileDigest: sha256("other-profile"),
			observerIdentity: "x",
			sourceLimits: { maxFiles: 10, maxFileBytes: 1, maxTotalBytes: 1 },
		});
		await expect(other.recover(scope())).rejects.toThrow(/another team profile/);
		// the intact state proves again
		expect((await s.recover(scope()))?.accepted.stageId).toBe("stage-1");
	});

	it("an archive member twice, a verdict other than the accepted one, and a canceled seal never become a boundary", async () => {
		const round = sealedRound();
		const s = store();
		// A canceled launch submits nothing, not even the first transfer.
		await expect(
			s.seal({
				saver,
				threadId: "att_team",
				state: state(certified),
				outcome: certified,
				roundResults: new Map([[1, round]]),
				ledger,
				evidence: {},
				signal: AbortSignal.abort(),
			}),
		).rejects.toMatchObject({ code: "CANCELED" });
		expect(sidecar.transfers).toHaveLength(0);
		expect(sidecar.results).toHaveLength(0);
		await s.seal({
			saver,
			threadId: "att_team",
			checkpointId: "cp-1",
			state: state(certified),
			outcome: certified,
			roundResults: new Map([[1, round]]),
			ledger,
			evidence: {},
		});
		// Control's accepted verdict binds the local result manifest.
		const accepted = sidecar.accepted;
		expect(accepted).toBeDefined();
		sidecar.accepted = { ...(accepted as NonNullable<typeof accepted>), verdict: "repairable" };
		await expect(s.recover(scope())).rejects.toThrow(/Control accepted repairable/);
		sidecar.accepted = accepted;
		// An archive that holds one member twice is refused, whichever copy a reader would see.
		const twice = path.join(root, "twice");
		mkdirSync(path.join(twice, "a"), { recursive: true });
		mkdirSync(path.join(twice, "b"), { recursive: true });
		writeFileSync(path.join(twice, "a", "manifest.json"), "{}");
		writeFileSync(path.join(twice, "b", "manifest.json"), '{"forged":true}');
		const file = path.join(twice, "stage.tar");
		await tar.create({ file, cwd: path.join(twice, "a"), portable: true }, ["manifest.json"]);
		await tar.replace({ file, cwd: path.join(twice, "b"), portable: true }, ["manifest.json"]);
		await expect(tarInventory(file)).rejects.toThrow(/holds this member twice/);
		await expect(stageArchiveMember(readFileSync(file), "manifest.json")).rejects.toBeInstanceOf(StageRefusedError);
		// The intact state proves.
		expect((await s.recover(scope()))?.accepted.stageId).toBe("stage-1");
	});

	it("a partial upload never becomes an accepted stage: a transfer that verifies other bytes stops the seal before any result", async () => {
		const round = sealedRound();
		// The sidecar double finalizes what it receives; the store compares the transfer's verified digest with the sealed archive.
		const client = new SidecarClient(sidecar.trustedSocket);
		const tampered = {
			...client,
			upload: async (cls: string, mt: string, body: Buffer) => ({
				...(await client.upload(cls, mt, body)),
				digest: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
			}),
		} as unknown as SidecarClient;
		const broken = new StageStore({
			dir: path.join(root, "stage-partial"),
			sidecar: tampered,
			identity,
			teamProfileDigest: profileDigest,
			observerIdentity: "x",
			sourceLimits: { maxFiles: 256, maxFileBytes: 1 << 20, maxTotalBytes: 16 << 20 },
		});
		await expect(
			broken.seal({
				saver,
				threadId: "att_team",
				state: state(certified),
				outcome: certified,
				roundResults: new Map([[1, round]]),
				ledger,
				evidence: {},
			}),
		).rejects.toThrow(/verified other bytes/);
		expect(sidecar.results).toHaveLength(0);
		expect(sidecar.accepted).toBeUndefined();
		// And a scope that ends between the uploads and the submission leaves no stage either: the uploads are nothing.
		const refusing = new FakeSidecar("stage-refuse");
		await refusing.start();
		try {
			const c = new SidecarClient(refusing.trustedSocket);
			let uploads = 0;
			const guarded = {
				...c,
				upload: async (cls: string, mt: string, body: Buffer) => {
					uploads++;
					const t = await c.upload(cls, mt, body);
					if (uploads === 3) refusing.trustedRefusal = { status: 403, code: "STALE_EXECUTION" };
					return t;
				},
				submit: (...a: Parameters<SidecarClient["submit"]>) => c.submit(...a),
			} as unknown as SidecarClient;
			const s3 = new StageStore({
				dir: path.join(root, "stage-refused"),
				sidecar: guarded,
				identity,
				teamProfileDigest: profileDigest,
				observerIdentity: "x",
				sourceLimits: { maxFiles: 256, maxFileBytes: 1 << 20, maxTotalBytes: 16 << 20 },
			});
			await expect(
				s3.seal({
					saver,
					threadId: "att_team",
					state: state(certified),
					outcome: certified,
					roundResults: new Map([[1, round]]),
					ledger,
					evidence: {},
				}),
			).rejects.toMatchObject({ code: "STALE_EXECUTION" });
			expect(refusing.transfers).toHaveLength(3);
			expect(refusing.results).toHaveLength(0);
			expect(refusing.accepted).toBeUndefined();
		} finally {
			await refusing.stop();
		}
	});
});
