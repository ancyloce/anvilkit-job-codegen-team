// The coordinator as the Go supervisor runs it: a child process with the
// process protocol on its stdio, here answered by a test double of the
// supervisor (the real one is exercised by anvilkit-job-codegen-supervisor
// and the parent's integration suite). What the attempt must never do is
// seal or submit after a final refusal, a protocol violation or the
// launch's cancellation, or certify without an independent validator.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sha256 } from "../src/digest.js";
import { encodeResult, type TeamResult } from "../src/protocol.js";
import { FakeSidecar } from "./doubles.js";
import { heroBrief, localRunner, teamScript } from "./helpers.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const pkg = path.resolve(here, "..");

const teamYaml = `
schemaVersion: 1
route: { id: controlled-openai-v1, contextWindow: 128000, maxTokens: 4096, exposurePerSend: "20000" }
currency: USD
parallelism: 2
recursionLimit: 64
deadlineMarginSeconds: 5
roles:
  planner: { maxCalls: 2, maxOutputTokens: 2048 }
  retrieval: { maxCalls: 2, maxOutputTokens: 1024 }
  coder: { maxCalls: 30, maxOutputTokens: 4096 }
  code_reviewer: { maxCalls: 2, maxOutputTokens: 2048 }
  security_reviewer: { maxCalls: 2, maxOutputTokens: 2048 }
aggregate: { maxCalls: 60, exposure: "1200000" }
reviews: { max: 2 }
repairs: { max: 2 }
compaction: { enabled: false, reserveTokens: 16384, keepRecentTokens: 8192 }
tools: [read, write, edit, ls, grep, find]
source: { maxFiles: 256, maxFileBytes: 1048576, maxTotalBytes: 16777216, maxSessionBytes: 8388608, maxReviewBytes: 262144 }
validation: { mode: none }
`;

type Supervisor = (req: Record<string, unknown>, ctx: { kill: () => void }) => Promise<unknown | undefined>;

interface Run {
	code: number | null;
	result: TeamResult;
	requests: Array<Record<string, unknown>>;
	log: string;
}

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

	function run(supervisor: Supervisor): Promise<Run> {
		const workspace = path.join(root, "workspace");
		const verdict = path.join(root, "verdict");
		const agent = path.join(root, "agent");
		const input = path.join(workspace, "input");
		for (const d of [workspace, verdict, input, path.join(agent, "team", "prompts")]) mkdirSync(d, { recursive: true });
		for (const f of [
			"tools.json",
			...["planner", "retrieval", "coder", "code_reviewer", "security_reviewer"].map((r) => `prompts/${r}.md`),
		])
			writeFileSync(path.join(agent, "team", f), readFileSync(path.join(pkg, "agent", "team", f)));
		const config = path.join(root, "team.yaml");
		writeFileSync(config, teamYaml);
		const brief = Buffer.from(JSON.stringify({ schemaVersion: 1, ...heroBrief }));
		writeFileSync(path.join(input, "brief"), brief);
		const scope = sidecar.scope as Record<string, string>;
		const envelope = {
			schemaVersion: 1,
			launchId: "launch_team",
			launchKey: scope.launchKey,
			operationId: scope.operationId,
			attemptId: scope.attemptId,
			profileId: scope.profileId,
			profileRevision: "2",
			jobKind: "codegen",
			executionEpoch: scope.executionEpoch,
			launchEpoch: "1",
			deadline: new Date(Date.now() + 10 * 60_000).toISOString().replace(/\.\d{3}Z$/, "Z"),
			inputs: [{ name: "brief", digest: sha256(brief) }],
		};
		const dist = path.join(pkg, "dist", "coordinator.js");
		const argv = existsSync(dist) ? [dist] : ["--import", "tsx", path.join(pkg, "src", "coordinator.ts")];
		const child = spawn(process.execPath, argv, {
			env: {
				PATH: process.env.PATH ?? "",
				HOME: verdict,
				ANVILKIT_TEAM_CONFIG: config,
				ANVILKIT_AGENT_DIR: agent,
				ANVILKIT_WORKSPACE: workspace,
				ANVILKIT_VERDICT_DIR: verdict,
				ANVILKIT_INPUT_DIR: input,
				ANVILKIT_TRUSTED_SOCKET: sidecar.trustedSocket,
				ANVILKIT_CANDIDATE_SOCKET: sidecar.candidateSocket,
				ANVILKIT_LAUNCH_ENVELOPE: JSON.stringify(envelope),
				ANVILKIT_OBSERVER_IDENTITY: "anvilkit-codegen-team",
				...(process.env.ANVILKIT_CODEGEN_TEAM_CONTRACTS_DIR
					? { ANVILKIT_CODEGEN_TEAM_CONTRACTS_DIR: process.env.ANVILKIT_CODEGEN_TEAM_CONTRACTS_DIR }
					: {}),
			},
			stdio: ["pipe", "pipe", "pipe"],
		});
		let log = "";
		child.stderr.on("data", (c: Buffer) => {
			log += c.toString();
		});
		const requests: Array<Record<string, unknown>> = [];
		const kill = () => child.kill("SIGTERM");
		createInterface({ input: child.stdout }).on("line", async (line) => {
			const req = JSON.parse(line) as Record<string, unknown>;
			requests.push(req);
			const answer = await supervisor(req, { kill });
			if (answer !== undefined && child.stdin.writable)
				child.stdin.write(`${typeof answer === "string" ? answer : JSON.stringify(answer)}\n`);
		});
		return new Promise((resolve) => {
			child.on("exit", (code) => {
				const result = JSON.parse(readFileSync(path.join(verdict, "team", "result.json"), "utf8")) as TeamResult;
				resolve({ code, result, requests, log });
			});
		});
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
		const r = await run(async (req) => {
			const report = await coder.run({ round: req.round as number, roundDir: req.roundDir as string });
			return {
				type: "candidate-ended",
				protocolVersion: 1,
				requestId: req.requestId,
				round: req.round,
				stop: report.stop,
				exit: report.exit,
				descendantsStopped: 0,
				startedAt: report.startedAt,
				endedAt: report.endedAt,
			};
		});
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
});
