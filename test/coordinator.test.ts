// The coordinator as the Go supervisor runs it: a child process with the
// process protocol on its stdio, here answered by a test double of the
// supervisor (the real one is exercised by anvilkit-job-codegen-supervisor
// and the parent's integration suite). What the attempt must never do is
// seal or submit after a final refusal, a protocol violation or the
// launch's cancellation, or certify without an independent validator.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { encodeResult } from "../src/protocol.js";
import { tarMembers } from "../src/stage/archive.js";
import { FakeSidecar } from "./doubles.js";
import {
	type CoordinatorLaunch,
	type CoordinatorRun,
	candidateEnded,
	heroBrief,
	localRunner,
	runCoordinator,
	type SupervisorDouble,
	teamScript,
} from "./helpers.js";

describe("coordinator", () => {
	let sidecar: FakeSidecar;
	let root: string;
	beforeEach(async () => {
		sidecar = new FakeSidecar("coordinator");
		await sidecar.start();
		sidecar.script = teamScript();
		root = mkdtempSync(path.join(tmpdir(), "coordinator-"));
	});
	afterEach(async () => {
		await sidecar.stop();
		rmSync(root, { recursive: true, force: true });
	});

	function run(
		supervisor: SupervisorDouble,
		launch: Partial<Omit<CoordinatorLaunch, "sidecar" | "root" | "supervisor">> = {},
	): Promise<CoordinatorRun> {
		return runCoordinator({ sidecar, root, supervisor, ...launch });
	}

	const refused = (req: Record<string, unknown>, code: string) => ({
		type: "refused",
		protocolVersion: 1,
		requestId: req.requestId,
		round: req.round,
		code,
		reason: "the test supervisor refuses",
	});

	it("a final refusal (the candidate's stop not established) ends the attempt with nothing sealed or submitted", async () => {
		const r = await run(async (req) => refused(req, "STOP_NOT_ESTABLISHED"));
		expect(r.code).toBe(1);
		expect(() => encodeResult(r.result)).not.toThrow();
		expect(r.result).toMatchObject({
			verdict: "infrastructure_failed",
			failureCode: "OBSERVER_FAILED",
			outcome: { kind: "infrastructure_failed", failureCode: "STOP_NOT_ESTABLISHED" },
		});
		expect(r.result.stageId).toBeUndefined();
		expect(r.requests).toHaveLength(1);
		expect(sidecar.transfers).toHaveLength(0);
		expect(sidecar.results).toHaveLength(0);
	});

	it("an answer the protocol does not allow ends the attempt with nothing sealed", async () => {
		const r = await run(async (req) => ({ ...refused(req, "TEAM_ENDED"), requestId: 99 }));
		expect(r.code).toBe(1);
		expect(r.result.outcome.kind).toBe("infrastructure_failed");
		expect(r.result.error).toMatch(/not asked for/);
		expect(sidecar.transfers).toHaveLength(0);
		expect(sidecar.results).toHaveLength(0);
	});

	it("the launch's cancellation while a round runs ends the attempt canceled, with nothing sealed", async () => {
		const r = await run(async (_req, { kill }) => {
			kill(); // the supervisor's SIGTERM while the candidate round is outstanding
			return undefined;
		});
		expect(r.code).toBe(1);
		expect(r.result).toMatchObject({ verdict: "canceled", failureCode: "CANCELED", outcome: { kind: "canceled" } });
		expect(sidecar.results).toHaveLength(0);
	});

	it("without an independent validator the run is never certified and never repaired; its stage records that", async () => {
		const coder = localRunner();
		const r = await run(async (req) =>
			candidateEnded(req, await coder.run({ round: req.round as number, roundDir: req.roundDir as string })),
		);
		expect(r.code, r.log).toBe(0);
		expect(r.result).toMatchObject({
			verdict: "infrastructure_failed",
			outcome: { kind: "validation_unavailable" },
			counters: { rounds: 1, repairs: 0 },
		});
		expect(r.result.stageId).toBe("stage-1");
		expect(r.requests).toHaveLength(1);
		// One accepted stage (the repeated submission reentered it), never a certified one.
		expect(sidecar.results.map((x) => x.verdict)).toEqual(["infrastructure_failed"]);
		expect(sidecar.accepted?.verdict).toBe("infrastructure_failed");
	});

	it("a launch whose envelope names another identity than the brief runs nothing and fails IDENTITY_MISMATCH", async () => {
		const r = await run(async () => undefined, {
			component: {
				componentId: heroBrief.componentId,
				puckType: "Banner",
				packageName: heroBrief.packageName,
				sourceRevision: "1",
			},
		});
		expect(r.code).toBe(1);
		expect(() => encodeResult(r.result)).not.toThrow();
		expect(r.result).toMatchObject({
			verdict: "infrastructure_failed",
			failureCode: "IDENTITY_MISMATCH",
			outcome: { kind: "infrastructure_failed", failureCode: "IDENTITY_MISMATCH" },
		});
		expect(r.result.error).toMatch(/puckType/);
		expect(r.requests).toHaveLength(0);
		expect(sidecar.requests).toHaveLength(0);
		expect(sidecar.results).toHaveLength(0);
	});

	it("the source revision is the launch's: the envelope's component binds it, and a launch that states none runs nothing", async () => {
		const { schemaVersion, componentId, puckType, packageName, version, requirements } = {
			schemaVersion: 1,
			...heroBrief,
		};
		const unrevised = { schemaVersion, componentId, puckType, packageName, version, requirements };
		const none = await run(async () => undefined, { brief: unrevised });
		expect(none.code).toBe(1);
		expect(none.result.error).toMatch(/no source revision/);
		expect(none.requests).toHaveLength(0);
		// The brief at revision 1 and an envelope at revision 7 disagree: refused as a mismatch, not resolved by either.
		const disagree = await run(async () => undefined, {
			component: { componentId, puckType, packageName, sourceRevision: "7" },
		});
		expect(disagree.result.failureCode).toBe("IDENTITY_MISMATCH");
		expect(disagree.result.error).toMatch(/sourceRevision/);
		// The envelope's component alone states the revision the coder writes.
		const coder = localRunner();
		const bound = await run(
			async (req) =>
				candidateEnded(req, await coder.run({ round: req.round as number, roundDir: req.roundDir as string })),
			{ brief: unrevised, component: { componentId, puckType, packageName, sourceRevision: "7" } },
		);
		expect(bound.code, bound.log).toBe(0);
		const coderCall = sidecar.requests.find((q) => q.callId.includes(":coder:"));
		expect(coderCall?.messages.at(-1)?.content).toContain("Implement source revision 7");
		expect(sidecar.results.at(-1)?.verdict).toBe("infrastructure_failed");
		const stage = sidecar.transfers.find((t) => t.class === "stage");
		const manifest = JSON.parse(String((await tarMembers(stage?.body ?? Buffer.alloc(0))).get("manifest.json")));
		expect(manifest.source).toMatchObject({ round: 1, revision: "7" });
	});
});
