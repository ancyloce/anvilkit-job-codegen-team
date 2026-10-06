import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MemorySaver } from "@langchain/langgraph";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type RelayRequest, SidecarClient } from "../src/adapters/sidecar.js";
import { zeroBudget } from "../src/budget.js";
import { parseTeamConfig, type TeamConfig, teamBudget } from "../src/config.js";
import { CodingExecutor, type ExecutorConfig, type RoundResult } from "../src/executor.js";
import { BudgetExhaustedError, ControlledModelPort, DeadlineExceededError } from "../src/port/model.js";
import { verdictFor } from "../src/stage/manifest.js";
import type { TeamDeps } from "../src/team/context.js";
import { buildTeamGraph, graphConfig } from "../src/team/graph.js";
import { reviewerRoles } from "../src/team/nodes/specialists.js";
import { loadPrompts, type RetrievalPort, SpecialistOutputError } from "../src/team/roles.js";
import type { TeamOutcome, TeamStateType } from "../src/team/state.js";
import type { ValidationInput, ValidationPort, ValidationResult } from "../src/validation.js";
import { FakeSidecar } from "./doubles.js";
import { heroBrief, localRunner, roleOf, teamScript } from "./helpers.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const agentDir = path.resolve(here, "..", "agent");

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
repairs: { max: 1 }
compaction: { enabled: false, reserveTokens: 16384, keepRecentTokens: 8192 }
tools: [read, write, edit, ls, grep, find]
source: { maxFiles: 256, maxFileBytes: 1048576, maxTotalBytes: 16777216, maxSessionBytes: 8388608, maxReviewBytes: 262144 }
validation: { mode: none }
`;

class ScriptedValidation implements ValidationPort {
	readonly inputs: ValidationInput[] = [];
	constructor(private readonly results: ValidationResult[]) {}
	async validate(input: ValidationInput): Promise<ValidationResult> {
		this.inputs.push(input);
		const r = this.results.shift();
		if (!r) throw new Error("validation script exhausted");
		return r;
	}
}

const certified = (): ValidationResult => ({
	status: "certified",
	certification: {
		verdict: "certified",
		complete: true,
		checks: [],
		bindings: {},
		digest: "sha256:0",
		dir: "/tmp/none",
	},
});
const repairable = (): ValidationResult => ({
	status: "repairable",
	failureCode: "MISSING_CSS",
	detail: "styles/hero.css: rule not in force",
	certification: {
		verdict: "repairable",
		failureCode: "MISSING_CSS",
		complete: true,
		checks: [],
		bindings: {},
		digest: "sha256:1",
		dir: "/tmp/none",
	},
});
const insufficient: RetrievalPort = {
	retrieve: async () => ({ status: "insufficient_evidence", reason: "knowledge upstream not configured (P16)" }),
};

describe("TeamRunner", () => {
	let sidecar: FakeSidecar;
	let workspace: string;
	let verdict: string;
	let config: TeamConfig;
	let attemptDeadline: Date;
	beforeEach(async () => {
		// The attempt's absolute deadline: one value for the whole attempt, as the launch envelope fixes it.
		attemptDeadline = new Date(Date.now() + 10 * 60_000);
		sidecar = new FakeSidecar("graph");
		await sidecar.start();
		sidecar.script = teamScript();
		workspace = mkdtempSync(path.join(tmpdir(), "team-ws-"));
		verdict = mkdtempSync(path.join(tmpdir(), "team-verdict-"));
		config = parseTeamConfig(teamYaml);
	});
	afterEach(async () => {
		await sidecar.stop();
		rmSync(workspace, { recursive: true, force: true });
		rmSync(verdict, { recursive: true, force: true });
	});

	function deps(
		over: Partial<TeamDeps> & { validation: ValidationPort },
		cfg = config,
		prefix = "att_team",
		dirs: { workspace?: string; sealDir?: string } = {},
	): TeamDeps {
		const client = new SidecarClient(sidecar.trustedSocket);
		const deadline = over.deadline ?? attemptDeadline;
		const port = new ControlledModelPort({
			relay: (r, o) => client.relay(r, o),
			routeId: cfg.route.id,
			deadline,
			callIdPrefix: prefix,
			maxConcurrent: cfg.parallelism,
		});
		const ex: ExecutorConfig = {
			workspace: dirs.workspace ?? workspace,
			sealDir: dirs.sealDir ?? path.join(verdict, "rounds"),
			candidateSocket: sidecar.candidateSocket,
			routeId: cfg.route.id,
			callIdPrefix: prefix,
			model: { contextWindow: cfg.route.contextWindow, maxTokens: cfg.route.maxTokens },
			compaction: cfg.compaction,
			tools: cfg.tools,
			systemPrompt: loadPrompts(agentDir).coder,
			deadline,
			limits: {
				maxCalls: cfg.roles.coder.maxCalls,
				maxOutputTokens: cfg.roles.coder.maxOutputTokens,
				exposurePerSend: cfg.route.exposurePerSend,
			},
			sourceLimits: cfg.source,
			maxSessionBytes: cfg.source.maxSessionBytes,
		};
		return {
			config: cfg,
			prompts: loadPrompts(agentDir),
			port,
			executor: new CodingExecutor(ex, localRunner()),
			retrieval: insufficient,
			deadline,
			roundResults: new Map<number, RoundResult>(),
			...over,
		};
	}

	it("the fixed roles run in order and within bounds: plan, no invented retrieval, one coder, two parallel reviewers, validation, certified", async () => {
		const validation = new ScriptedValidation([certified()]);
		const d = deps({ validation });
		const graph = buildTeamGraph(d, new MemorySaver());
		const final = (await graph.invoke(
			{ brief: heroBrief, sourceRevision: "1" },
			graphConfig(config, "att_team"),
		)) as TeamStateType;
		expect(final.outcome?.kind).toBe("certified");
		expect(final.plan?.steps.length).toBe(3);
		expect(final.retrieval?.status).toBe("insufficient_evidence");
		expect(final.retrieval?.calls).toBe(0);
		expect(final.rounds).toHaveLength(1);
		expect(final.rounds[0]?.files).toBe(8);
		expect(final.reviews.map((r) => r.role).sort()).toEqual(["code_reviewer", "security_reviewer"]);
		expect(final.reviews.every((r) => r.manifestDigest === final.rounds[0]?.manifestDigest)).toBe(true);
		expect(final.reviewRounds).toBe(1);
		expect(final.validations).toHaveLength(1);
		expect(validation.inputs[0]?.source.manifestDigest).toBe(final.rounds[0]?.manifestDigest);
		// Budgets: every call charged to its role at its declared exposure; the aggregate is their sum.
		expect(final.budget.spent.planner).toEqual({ calls: 1, exposure: "20000" });
		expect(final.budget.spent.retrieval).toEqual({ calls: 0, exposure: "0" });
		expect(final.budget.spent.code_reviewer.calls).toBe(1);
		expect(final.budget.spent.security_reviewer.calls).toBe(1);
		expect(final.budget.spent.coder.calls).toBe(9);
		expect(final.budget.total.calls).toBe(12);
		expect(BigInt(final.budget.total.exposure)).toBe(12n * 20000n);
		// Every model send went through the relay under a role identity, once; the reviewers ran concurrently, bounded by 2.
		const roles = sidecar.requests.map(roleOf);
		expect(roles.filter((r) => r === "planner")).toHaveLength(1);
		expect(roles.filter((r) => r === "coder")).toHaveLength(9);
		expect(sidecar.totalSends()).toBe(sidecar.requests.length);
		expect(d.port.peakConcurrency).toBe(2);
		expect(sidecar.requests.find((q) => roleOf(q) === "planner")?.callId).toBe("att_team:planner:1");
		expect(sidecar.requests.find((q) => roleOf(q) === "code_reviewer")?.callId).toBe("att_team:code_reviewer:1");
	});

	it("only a repairable validator result sends the team back to the coder, once per the repair bound, then the run ends repairable", async () => {
		const validation = new ScriptedValidation([repairable(), repairable(), repairable()]);
		const d = deps({ validation });
		let repairs = 0;
		sidecar.script = teamScript({
			coder: (req: RelayRequest) => {
				const last = req.messages.at(-1);
				if (last?.role === "user" && /Repair round/.test(last.content)) {
					repairs++;
					return {
						text: ["Repairing."],
						tools: [
							{
								id: `tc_fix_${repairs}`,
								name: "edit",
								arguments: JSON.stringify({
									path: "styles/hero.css",
									edits: [{ oldText: ".ak-hero {", newText: ".ak-hero { /* repaired */" }],
								}),
							},
						],
					};
				}
				if (last?.role === "tool" && /edit/.test(String(req.messages.at(-2)?.toolCalls?.[0]?.name)))
					return { text: ["Repaired."] };
				return teamScript()(req);
			},
		});
		const graph = buildTeamGraph(d, new MemorySaver());
		const final = (await graph.invoke(
			{ brief: heroBrief, sourceRevision: "1" },
			graphConfig(config, "att_team"),
		)) as TeamStateType;
		expect(final.rounds.map((r) => r.kind)).toEqual(["code", "repair"]);
		expect(final.repairs).toBe(1);
		expect(final.rounds[1]?.sourceRevision).toBe("2");
		expect(final.rounds[1]?.manifestDigest).not.toBe(final.rounds[0]?.manifestDigest);
		expect(final.reviewRounds).toBe(2);
		expect(final.validations).toHaveLength(2);
		expect(final.outcome?.kind).toBe("repairable");
		expect(final.outcome?.failureCode).toBe("MISSING_CSS");
		expect(final.outcome?.detail).toContain("repair bound");
		// The repair prompt carried the validator's classification and the repair round continued the coder's session.
		const repairCall = sidecar.requests.find(
			(q) => roleOf(q) === "coder" && /Repair round/.test(q.messages.at(-1)?.content ?? ""),
		);
		expect(repairCall?.messages.at(-1)?.content).toContain("MISSING_CSS");
		expect(repairCall?.callId).toBe("att_team:r2:coder:1");
		expect(sidecar.totalSends()).toBe(sidecar.requests.length);
	});

	it("infrastructure, invalid and unavailable validation never start a repair", async () => {
		for (const [res, kind] of [
			[
				{ status: "infrastructure_failed", failureCode: "OBSERVER_FAILED", detail: "browser step lost" },
				"infrastructure_failed",
			],
			[
				{
					status: "invalid",
					failureCode: "PATH_ESCAPE",
					detail: "link",
					certification:
						certified().status === "certified" ? (certified() as { certification: unknown }).certification : undefined,
				},
				"invalid",
			],
			[{ status: "unavailable", reason: "no validator" }, "validation_unavailable"],
		] as Array<[ValidationResult, string]>) {
			const ws = mkdtempSync(path.join(tmpdir(), "team-ws-"));
			const d = deps({ validation: new ScriptedValidation([res]) }, config, `att_${kind}`, {
				workspace: ws,
				sealDir: path.join(ws, "seal"),
			});
			const final = (await buildTeamGraph(d, new MemorySaver()).invoke(
				{ brief: heroBrief, sourceRevision: "1" },
				graphConfig(config, `att_${kind}`),
			)) as TeamStateType;
			expect(final.rounds).toHaveLength(1);
			expect(final.repairs).toBe(0);
			expect(final.outcome?.kind).toBe(kind);
			rmSync(ws, { recursive: true, force: true });
		}
	});

	it("a specialist answer outside its schema is asked again within the role budget; an invented citation is refused", async () => {
		let plannerCalls = 0;
		const evidence: RetrievalPort = {
			retrieve: async () => ({
				status: "evidence",
				evidence: [{ id: "ev-1", source: "conventions.md", text: "Hero sections use the ak-hero block." }],
			}),
		};
		let retrievalCalls = 0;
		sidecar.script = teamScript({
			planner: () => {
				plannerCalls++;
				if (plannerCalls === 1) return { text: ["Here is my plan in prose instead of the tool."] };
				return {
					text: ["Planning."],
					tools: [
						{
							id: "tc_plan2",
							name: "submit_plan",
							arguments: JSON.stringify({ ...heroPlanOf(), steps: heroPlanOf().steps }),
						},
					],
				};
			},
			retrieval: () => {
				retrievalCalls++;
				const citations = retrievalCalls === 1 ? ["ev-1", "ev-999"] : ["ev-1"];
				return {
					text: ["Answering."],
					tools: [
						{
							id: `tc_ret_${retrievalCalls}`,
							name: "submit_retrieval",
							arguments: JSON.stringify({ answer: "Use the ak-hero block.", citations }),
						},
					],
				};
			},
		});
		const d = deps({ validation: new ScriptedValidation([certified()]), retrieval: evidence });
		const final = (await buildTeamGraph(d, new MemorySaver()).invoke(
			{ brief: heroBrief, sourceRevision: "1" },
			graphConfig(config, "att_team"),
		)) as TeamStateType;
		expect(plannerCalls).toBe(2);
		expect(final.budget.spent.planner.calls).toBe(2);
		expect(retrievalCalls).toBe(2);
		expect(final.retrieval).toMatchObject({ status: "evidence", citations: ["ev-1"], calls: 2 });
		const correction = sidecar.requests.filter((q) => roleOf(q) === "planner")[1];
		expect(correction?.messages.at(-1)?.content).toMatch(/Rejected: expected exactly one submit_plan call/);
		// A role that never answers within its schema ends the run with its budget spent and nothing else sent.
		sidecar.script = teamScript({ planner: () => ({ text: ["prose"] }) });
		const ws = mkdtempSync(path.join(tmpdir(), "team-ws-"));
		const d2 = deps({ validation: new ScriptedValidation([certified()]) }, config, "att_x", {
			workspace: ws,
			sealDir: path.join(ws, "seal"),
		});
		await expect(
			buildTeamGraph(d2, new MemorySaver()).invoke(
				{ brief: heroBrief, sourceRevision: "1" },
				graphConfig(config, "att_x"),
			),
		).rejects.toBeInstanceOf(SpecialistOutputError);
		expect(sidecar.requests.filter((q) => q.callId.startsWith("att_x:") && roleOf(q) === "coder")).toHaveLength(0);
		expect(sidecar.requests.filter((q) => q.callId.startsWith("att_x:"))).toHaveLength(2);
		rmSync(ws, { recursive: true, force: true });
	});

	it("a budget or deadline bound ends the run before a send; missing limits refuse the configuration", async () => {
		// The aggregate funds one send at the per-send exposure: the planner's.
		const tight = parseTeamConfig(
			teamYaml.replace(
				'aggregate: { maxCalls: 60, exposure: "1200000" }',
				'aggregate: { maxCalls: 60, exposure: "30000" }',
			),
		);
		const d = deps({ validation: new ScriptedValidation([certified()]) }, tight);
		await expect(
			buildTeamGraph(d, new MemorySaver()).invoke(
				{ brief: heroBrief, sourceRevision: "1" },
				graphConfig(tight, "att_team"),
			),
		).rejects.toBeInstanceOf(BudgetExhaustedError);
		expect(sidecar.requests.filter((q) => roleOf(q) === "coder")).toHaveLength(0);
		const late = deps(
			{ validation: new ScriptedValidation([certified()]), deadline: new Date(Date.now() + 1000) },
			config,
			"att_late",
		);
		await expect(
			buildTeamGraph(late, new MemorySaver()).invoke(
				{ brief: heroBrief, sourceRevision: "1" },
				graphConfig(config, "att_late"),
			),
		).rejects.toBeInstanceOf(DeadlineExceededError);
		expect(() => parseTeamConfig(teamYaml.replace("repairs: { max: 1 }\n", ""))).toThrow(/repairs/);
		expect(() => parseTeamConfig(teamYaml.replace("parallelism: 2", "parallelism: 1"))).toThrow(/parallelism/);
		expect(() => parseTeamConfig(teamYaml.replace(', exposurePerSend: "20000"', ""))).toThrow(/exposurePerSend/);
		expect(() =>
			parseTeamConfig(
				teamYaml.replace(
					'aggregate: { maxCalls: 60, exposure: "1200000" }',
					'aggregate: { maxCalls: 60, exposure: "19999" }',
				),
			),
		).toThrow(/funds no send/);
		expect(() =>
			parseTeamConfig(
				teamYaml.replace(
					"planner: { maxCalls: 2, maxOutputTokens: 2048 }",
					'planner: { maxCalls: 2, maxOutputTokens: 2048, exposurePerCall: "1" }',
				),
			),
		).toThrow(/team configuration/);
	});

	it("an unknown outcome after the coder wrote source ends the run: no reviewer, validation or repair send, no success, and reentry revives nothing", async () => {
		const saver = SqliteSaver.fromConnString(path.join(verdict, "checkpoints-unknown.sqlite"));
		const hero = teamScript();
		let coderCalls = 0;
		sidecar.script = (req: RelayRequest) => {
			if (roleOf(req) !== "coder") return hero(req);
			coderCalls++;
			return coderCalls === 4 ? { behaviour: "unknown" } : hero(req);
		};
		const validation = new ScriptedValidation([certified()]);
		const d = deps({ validation }, config, "att_unknown");
		const cfg = graphConfig(config, "att_unknown");
		const final = (await buildTeamGraph(d, saver).invoke(
			{ brief: heroBrief, sourceRevision: "1" },
			cfg,
		)) as TeamStateType;
		expect(final.outcome).toMatchObject({ kind: "effect_uncertain", failureCode: "EFFECT_UNCERTAIN", round: 1 });
		expect(final.rounds).toHaveLength(1);
		expect(final.rounds[0]).toMatchObject({ ended: "call_failed", failureCode: "EFFECT_UNCERTAIN", files: 3 });
		expect(final.reviews).toHaveLength(0);
		expect(final.validations).toHaveLength(0);
		expect(validation.inputs).toHaveLength(0);
		// The planner's call and the coder's four (three writes and the one that ended unknown): nothing after it.
		const sent = () => sidecar.requests.filter((q) => q.callId.startsWith("att_unknown:"));
		expect(sent().map((q) => q.callId)).toEqual([
			"att_unknown:planner:1",
			"att_unknown:r1:coder:1",
			"att_unknown:r1:coder:2",
			"att_unknown:r1:coder:3",
			"att_unknown:r1:coder:4",
		]);
		expect(sidecar.totalSends()).toBe(5);
		const sendsBefore = sidecar.totalSends();
		// Checkpoint reentry: the run ended; nothing is pending and nothing sends.
		const state = await buildTeamGraph(d, saver).getState(cfg);
		expect(state.next).toEqual([]);
		const again = (await buildTeamGraph(d, saver).invoke(null, cfg)) as TeamStateType;
		expect(again.outcome?.kind).toBe("effect_uncertain");
		expect(sidecar.totalSends()).toBe(sendsBefore);
		expect(sent()).toHaveLength(5);
		// A rerun from scratch over the same workspace (the Pod's paths are fixed) under the same identities reenters
		// the record, which is still unknown: the same stop, no send, no new ordinal.
		const d2 = deps({ validation: new ScriptedValidation([certified()]) }, config, "att_unknown", {
			sealDir: path.join(verdict, "rounds-unknown-rerun"),
		});
		const rerun = (await buildTeamGraph(d2, new MemorySaver()).invoke(
			{ brief: heroBrief, sourceRevision: "1" },
			graphConfig(config, "att_unknown_2"),
		)) as TeamStateType;
		expect(rerun.outcome?.kind).toBe("effect_uncertain");
		expect(sidecar.totalSends()).toBe(sendsBefore);
		expect(sent().filter((q) => q.callId === "att_unknown:r1:coder:4")).toHaveLength(2);
		expect(sent().some((q) => q.callId === "att_unknown:r1:coder:5")).toBe(false);
		saver.db.close();
	});

	it("one remaining aggregate allowance funds one reviewer send, never two: reservations are taken before the fan-out", async () => {
		// The planner's call and the coder's nine leave one call and 20000 of exposure of the aggregate 11/220000.
		const eleven = parseTeamConfig(
			teamYaml.replace(
				'aggregate: { maxCalls: 60, exposure: "1200000" }',
				'aggregate: { maxCalls: 11, exposure: "220000" }',
			),
		);
		const d = deps({ validation: new ScriptedValidation([certified()]) }, eleven, "att_eleven");
		await expect(
			buildTeamGraph(d, new MemorySaver()).invoke(
				{ brief: heroBrief, sourceRevision: "1" },
				graphConfig(eleven, "att_eleven"),
			),
		).rejects.toBeInstanceOf(BudgetExhaustedError);
		// The refusal ends the superstep while the funded reviewer's one send may still be in flight: let it land.
		await settle();
		const sent = sidecar.requests.filter((q) => q.callId.startsWith("att_eleven:"));
		expect(sent.length).toBeLessThanOrEqual(11);
		expect(sidecar.totalSends()).toBe(sent.length);
		expect(sent.reduce((sum, q) => sum + BigInt(q.maxExposure.amount), 0n)).toBeLessThanOrEqual(220000n);
		// The one share went to the first reviewer in the fixed order; the other reviewer refused before any send.
		expect(sent.filter((q) => roleOf(q) === "code_reviewer").length).toBeLessThanOrEqual(1);
		expect(sent.filter((q) => roleOf(q) === "security_reviewer")).toHaveLength(0);
		// The same with the exposure as the binding bound: 60 calls but 220000 in aggregate.
		const exposureBound = parseTeamConfig(
			teamYaml.replace(
				'aggregate: { maxCalls: 60, exposure: "1200000" }',
				'aggregate: { maxCalls: 60, exposure: "220000" }',
			),
		);
		const ws = mkdtempSync(path.join(tmpdir(), "team-ws-"));
		const d2 = deps({ validation: new ScriptedValidation([certified()]) }, exposureBound, "att_exposure", {
			workspace: ws,
			sealDir: path.join(ws, "seal"),
		});
		await expect(
			buildTeamGraph(d2, new MemorySaver()).invoke(
				{ brief: heroBrief, sourceRevision: "1" },
				graphConfig(exposureBound, "att_exposure"),
			),
		).rejects.toBeInstanceOf(BudgetExhaustedError);
		await settle();
		const sent2 = sidecar.requests.filter((q) => q.callId.startsWith("att_exposure:"));
		expect(sent2.reduce((sum, q) => sum + BigInt(q.maxExposure.amount), 0n)).toBeLessThanOrEqual(220000n);
		expect(sent2.length).toBeLessThanOrEqual(11);
		expect(sent2.filter((q) => roleOf(q) === "security_reviewer")).toHaveLength(0);
		rmSync(ws, { recursive: true, force: true });
		// The shares themselves: never more than the aggregate, bounded by each role, the remainder to the first.
		const spent = { ...zeroBudget(), total: { calls: 10, exposure: "200000" } };
		const one = teamBudget(eleven).reserveParallel(spent, reviewerRoles);
		expect(one.code_reviewer).toMatchObject({ calls: 1, exposure: { amount: "20000" }, aggregateCalls: 1 });
		expect(one.security_reviewer).toMatchObject({ calls: 0, exposure: { amount: "0" }, aggregateCalls: 0 });
		const plenty = teamBudget(config).reserveParallel(spent, reviewerRoles);
		expect(plenty.code_reviewer).toMatchObject({ calls: 2, aggregateCalls: 2 });
		expect(plenty.security_reviewer).toMatchObject({ calls: 2, aggregateCalls: 2 });
		// Exposure is reserved in whole calls: 50000 left funds two calls of 20000, one each; 3 calls left with ample exposure: two and one.
		const twoCalls = teamBudget({
			...eleven,
			aggregate: { maxCalls: 13, exposure: { currency: "USD", amount: "250000" } },
		}).reserveParallel(spent, reviewerRoles);
		expect(twoCalls.code_reviewer).toMatchObject({ calls: 1, exposure: { amount: "20000" } });
		expect(twoCalls.security_reviewer).toMatchObject({ calls: 1, exposure: { amount: "20000" } });
		const threeCalls = teamBudget({
			...eleven,
			aggregate: { maxCalls: 13, exposure: { currency: "USD", amount: "900000" } },
		}).reserveParallel(spent, reviewerRoles);
		expect(threeCalls.code_reviewer).toMatchObject({ calls: 2, exposure: { amount: "40000" } });
		expect(threeCalls.security_reviewer).toMatchObject({ calls: 1, exposure: { amount: "20000" } });
	});

	it("a checkpointed run resumes from its last step without repeating earlier sends, and a rerun from scratch reenters every call without a send", async () => {
		const saver = SqliteSaver.fromConnString(path.join(verdict, "checkpoints.sqlite"));
		const failing: ValidationPort = {
			validate: async () => {
				throw new Error("validator process lost");
			},
		};
		const d = deps({ validation: failing });
		const cfg = graphConfig(config, "att_team");
		await expect(buildTeamGraph(d, saver).invoke({ brief: heroBrief, sourceRevision: "1" }, cfg)).rejects.toThrow(
			/validator process lost/,
		);
		const sendsBefore = sidecar.totalSends();
		const requestsBefore = sidecar.requests.length;
		// Resume: the checkpoint after the reviewers is the boundary; only validate runs again.
		const events: string[] = [];
		const d2 = { ...d, validation: new ScriptedValidation([certified()]), log: (e: string) => events.push(e) };
		const before = await buildTeamGraph(d2, saver).getState(cfg);
		expect(before.next).toEqual(["validate"]);
		const resumed = (await buildTeamGraph(d2, saver).invoke(null, cfg)) as TeamStateType;
		expect(events).toEqual(["validate"]);
		expect(resumed.outcome?.kind).toBe("certified");
		expect(sidecar.requests.length).toBe(requestsBefore);
		expect(sidecar.totalSends()).toBe(sendsBefore);
		// A new coordinator process over the same workspace (the Pod's paths are fixed), a fresh thread, a fresh
		// executor and a fresh seal directory reenters the same identities and bytes: no physical send.
		const d3 = deps({ validation: new ScriptedValidation([certified()]) }, config, "att_team", {
			sealDir: path.join(verdict, "rounds-restart"),
		});
		const again = (await buildTeamGraph(d3, new MemorySaver()).invoke(
			{ brief: heroBrief, sourceRevision: "1" },
			graphConfig(config, "att_team_2"),
		)) as TeamStateType;
		expect(again.outcome?.kind).toBe("certified");
		expect(again.rounds[0]?.manifestDigest).toBe(resumed.rounds[0]?.manifestDigest);
		expect(sidecar.totalSends()).toBe(sendsBefore);
		// Reentered calls are accounted once per run, as the original run accounted them: no duplicate charge.
		expect(again.budget.total).toEqual(resumed.budget.total);
		expect(again.budget.total.calls).toBe(12);
		expect(sidecar.requests.length).toBeGreaterThan(requestsBefore);
		saver.db.close();
	});

	it("a coder call Control refuses ends the run as model_denied: no reviewer, no validation, no repair, never a candidate verdict", async () => {
		const hero = teamScript();
		sidecar.script = (req: RelayRequest) =>
			roleOf(req) === "coder" ? { behaviour: "refuse", refuseCode: "BUDGET_EXHAUSTED", refuseStatus: 429 } : hero(req);
		const validation = new ScriptedValidation([repairable(), certified()]);
		const d = deps({ validation }, config, "att_denied");
		const final = (await buildTeamGraph(d, new MemorySaver()).invoke(
			{ brief: heroBrief, sourceRevision: "1" },
			graphConfig(config, "att_denied"),
		)) as TeamStateType;
		expect(final.outcome).toMatchObject({ kind: "model_denied", failureCode: "BUDGET_EXHAUSTED", round: 1 });
		expect(final.rounds).toHaveLength(1);
		expect(final.rounds[0]).toMatchObject({ ended: "call_failed", failureCode: "BUDGET_EXHAUSTED" });
		expect(final.reviews).toHaveLength(0);
		expect(final.validations).toHaveLength(0);
		expect(validation.inputs).toHaveLength(0);
		const sent = sidecar.requests.filter((q) => q.callId.startsWith("att_denied:"));
		expect(sent.map((q) => roleOf(q))).toEqual(["planner", "coder"]);
		expect(verdictFor(final.outcome as TeamOutcome)).toEqual({
			verdict: "infrastructure_failed",
			failureCode: "OBSERVER_FAILED",
		});
	});

	it("a coder round that runs out of its allowance ends the run as budget_exhausted before another send", async () => {
		const three = parseTeamConfig(teamYaml.replace("coder: { maxCalls: 30,", "coder: { maxCalls: 3,"));
		const validation = new ScriptedValidation([certified()]);
		const d = deps({ validation }, three, "att_allowance");
		const final = (await buildTeamGraph(d, new MemorySaver()).invoke(
			{ brief: heroBrief, sourceRevision: "1" },
			graphConfig(three, "att_allowance"),
		)) as TeamStateType;
		expect(final.outcome).toMatchObject({ kind: "budget_exhausted", failureCode: "BUDGET_EXHAUSTED", round: 1 });
		const coder = sidecar.requests.filter((q) => q.callId.startsWith("att_allowance:") && roleOf(q) === "coder");
		expect(coder).toHaveLength(3);
		expect(final.budget.spent.coder).toEqual({ calls: 3, exposure: "60000" });
		expect(final.reviews).toHaveLength(0);
		expect(validation.inputs).toHaveLength(0);
	});

	it("every send declares exactly the per-send exposure Control reserves", async () => {
		const d = deps({ validation: new ScriptedValidation([certified()]) }, config, "att_declared");
		await buildTeamGraph(d, new MemorySaver()).invoke(
			{ brief: heroBrief, sourceRevision: "1" },
			graphConfig(config, "att_declared"),
		);
		const sent = sidecar.requests.filter((q) => q.callId.startsWith("att_declared:"));
		expect(sent.length).toBeGreaterThan(3);
		for (const q of sent) expect(q.maxExposure).toEqual({ currency: "USD", amount: "20000" });
	});
});

/** Lets requests already issued by an ended run reach the sidecar double before its log is read. */
async function settle(): Promise<void> {
	await new Promise((r) => setTimeout(r, 500));
}

function heroPlanOf() {
	return {
		componentId: "cmp_hero_fixed",
		puckType: "Hero",
		packageName: "@anvilkit/hero-fixed",
		version: "1.0.0",
		steps: [{ id: "all", title: "Everything", files: ["component.json"], detail: "All files of the fixed Hero." }],
	};
}
