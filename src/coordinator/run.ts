// The team's execution in one attempt (DD-03 §1/§2): the ports and adapters
// assembled over the coordinator's inputs — the controlled model port on the
// sidecar's relay, the coding executor over the supervisor's protocol, the
// independent validator (or its declared absence), the retrieval route —
// the bounded LangGraph run under the launch's cancellation, and the class
// of an end by error. A final refusal of the supervisor or the launch's
// cancellation ends the run without a stage: nothing proves that no
// candidate still writes, or the launch is ending.
import { existsSync, renameSync } from "node:fs";
import path from "node:path";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import { SidecarError } from "../adapters/sidecar.js";
import { SupervisorRunner } from "../adapters/supervisor.js";
import { ValidatorCli } from "../adapters/validator.js";
import { teamBudget } from "../config.js";
import { sha256 } from "../digest.js";
import { CandidateRoundRefusedError, CodingExecutor, type RoundResult, trustedDir } from "../executor.js";
import {
	BudgetExhaustedError,
	ControlledModelPort,
	DeadlineExceededError,
	EffectUncertainError,
	ModelCallRefusedError,
} from "../port/model.js";
import { ProtocolViolationError } from "../protocol.js";
import { buildTeamGraph, graphConfig } from "../team/graph.js";
import { SidecarRetrieval } from "../team/retrieval.js";
import { SpecialistOutputError } from "../team/roles.js";
import type { TeamOutcome, TeamStateType } from "../team/state.js";
import { UnavailableValidation, type ValidationPort } from "../validation.js";
import type { CoordinatorInputs } from "./inputs.js";
import type { PriorSeed } from "./recovery.js";

/** The launch was canceled while the team ran: nothing is sealed or submitted. */
export class RunCanceledError extends Error {
	constructor() {
		super("the launch was canceled while the team ran");
		this.name = "RunCanceledError";
	}
}

export interface TeamRun {
	state: TeamStateType;
	outcome: TeamOutcome;
	checkpointId?: string;
	saver: SqliteSaver;
	port: ControlledModelPort;
	roundResults: Map<number, RoundResult>;
}

/** The outcome class of a run that ended by an error instead of a seal decision. */
export function outcomeOfError(err: unknown, lastRound?: number): TeamOutcome {
	const e = err as Error;
	const base = { detail: (e?.message ?? String(err)).slice(0, 1000), round: lastRound };
	if (e instanceof BudgetExhaustedError) return { kind: "budget_exhausted", failureCode: "BUDGET_EXHAUSTED", ...base };
	if (e instanceof DeadlineExceededError) return { kind: "deadline", failureCode: "DEADLINE_EXCEEDED", ...base };
	if (e instanceof EffectUncertainError) return { kind: "effect_uncertain", failureCode: "EFFECT_UNCERTAIN", ...base };
	if (e instanceof ModelCallRefusedError) return { kind: "model_denied", failureCode: e.code, ...base };
	if (e instanceof CandidateRoundRefusedError || e instanceof ProtocolViolationError)
		return { kind: "infrastructure_failed", failureCode: "OBSERVER_FAILED", ...base };
	if (e instanceof SpecialistOutputError) return { kind: "failed", ...base };
	if (e instanceof SidecarError) return { kind: "infrastructure_failed", failureCode: "OBSERVER_FAILED", ...base };
	if (e?.name === "AbortError") return { kind: "canceled", ...base };
	return { kind: "failed", ...base };
}

/** Whether an error ends the attempt without a stage. */
export function endsWithoutStage(err: unknown): boolean {
	return (
		err instanceof RunCanceledError ||
		(err instanceof CandidateRoundRefusedError && err.final) ||
		err instanceof ProtocolViolationError
	);
}

export async function runTeam(
	inputs: CoordinatorInputs,
	start: { brief: TeamStateType["brief"] & { sourceRevision: string }; prior?: PriorSeed },
	signal: AbortSignal,
	log: (event: string, fields?: Record<string, unknown>) => void,
): Promise<TeamRun> {
	const { config, prompts, scope, workspace, deadline } = inputs;
	const teamDir = path.join(inputs.verdictDir, "team");
	// The trusted side's directories under the candidate-writable workspace
	// exist before any candidate runs, so no candidate can plant them.
	trustedDir(path.join(workspace, "round"));
	trustedDir(path.join(workspace, "validation"));
	const budget = teamBudget(config);
	const port = new ControlledModelPort({
		relay: (r, o) => inputs.sidecar.relay(r, o),
		routeId: config.route.id,
		deadline,
		callIdPrefix: scope.attemptId,
		maxConcurrent: config.parallelism,
		deadlineMarginMs: config.deadlineMarginSeconds * 1000,
		ledgerPath: path.join(teamDir, "calls.jsonl"),
	});
	const executor = new CodingExecutor(
		{
			workspace,
			sealDir: path.join(teamDir, "rounds"),
			candidateSocket: inputs.candidateSocket,
			routeId: config.route.id,
			callIdPrefix: scope.attemptId,
			model: { contextWindow: config.route.contextWindow, maxTokens: config.route.maxTokens },
			compaction: config.compaction,
			tools: config.tools,
			systemPrompt: prompts.coder,
			deadline,
			limits: {
				maxCalls: config.roles.coder.maxCalls,
				maxOutputTokens: config.roles.coder.maxOutputTokens,
				exposurePerSend: budget.perSend,
			},
			sourceLimits: config.source,
			maxSessionBytes: config.source.maxSessionBytes,
		},
		new SupervisorRunner(),
	);
	const validation: ValidationPort =
		config.validation.mode === "validator" && config.validation.validator
			? // The validator's build, SSR and browser steps run as the candidate
				// identity: their work tree must be traversable by it, so the runs
				// live under the workspace, not the root-only verdict tree; the
				// coordinator reads the certification from there.
				new ValidatorCli({ config: config.validation.validator, runDir: path.join(workspace, "validation"), log })
			: new UnavailableValidation("validation.mode is none: no independent validator in this environment");
	const roundResults = new Map<number, RoundResult>();
	// A checkpoint database left by an earlier coordinator of this launch is
	// not this run's state (Control's accepted stage is the only boundary):
	// it is kept aside as evidence, never resumed.
	const checkpoints = path.join(teamDir, "checkpoints.sqlite");
	if (existsSync(checkpoints)) {
		const aside = path.join(teamDir, `checkpoints.stale-${Date.now()}.sqlite`);
		for (const suffix of ["", "-wal", "-shm"])
			if (existsSync(checkpoints + suffix)) renameSync(checkpoints + suffix, aside + suffix);
		log("an earlier checkpoint database of this launch was set aside");
	}
	const saver = SqliteSaver.fromConnString(checkpoints);
	const graph = buildTeamGraph(
		{
			config,
			prompts,
			port,
			executor,
			retrieval: new SidecarRetrieval(inputs.trustedSocket),
			validation,
			deadline,
			roundResults,
			log,
		},
		saver,
	);
	const cfg = { ...graphConfig(config, scope.attemptId), signal };
	const initial: Partial<TeamStateType> = start.prior
		? {
				brief: start.brief,
				sourceRevision: start.prior.sourceRevision,
				rounds: [start.prior.round],
				validations: [start.prior.validation],
				repairs: start.prior.repairs,
				reviewRounds: start.prior.reviewRounds,
				budget: start.prior.budget,
			}
		: { brief: start.brief, sourceRevision: start.brief.sourceRevision };
	let state: TeamStateType;
	let outcome: TeamOutcome;
	try {
		state = (await graph.invoke(initial, cfg)) as TeamStateType;
		outcome = state.outcome ?? { kind: "failed", detail: "the run ended without an outcome" };
	} catch (err) {
		if (signal.aborted) throw new RunCanceledError();
		if (endsWithoutStage(err)) throw err;
		state = (await graph.getState(cfg)).values as TeamStateType;
		outcome = outcomeOfError(err, state.rounds?.at(-1)?.round);
		log("team run ended by an error", {
			kind: outcome.kind,
			failureCode: outcome.failureCode,
			detail: outcome.detail.slice(0, 300),
		});
	}
	if (signal.aborted) throw new RunCanceledError();
	const snapshot = await graph.getState(cfg);
	const checkpointId = (snapshot.config?.configurable as { checkpoint_id?: string } | undefined)?.checkpoint_id;
	return { state, outcome, checkpointId, saver, port, roundResults };
}

/** The evidence document of a run (private evidence: the stage binds it). */
export function runEvidence(inputs: CoordinatorInputs, run: TeamRun, started: Date): Record<string, unknown> {
	const { state, outcome, port } = run;
	return {
		schemaVersion: 1,
		kind: "codegen-team",
		launchId: inputs.envelope.launchId,
		attemptId: inputs.scope.attemptId,
		teamProfileDigest: inputs.profileDigest,
		configDigest: sha256(inputs.configText),
		startedAt: started.toISOString(),
		deadline: inputs.deadline.toISOString(),
		exposurePerSend: inputs.config.route.exposurePerSend,
		plan: state.plan,
		retrieval: state.retrieval,
		rounds: state.rounds,
		reviews: state.reviews,
		validations: state.validations.map((v) => ({
			round: v.round,
			sourceRevision: v.sourceRevision,
			manifestDigest: v.manifestDigest,
			status: v.result.status,
			failureCode: "failureCode" in v.result ? v.result.failureCode : undefined,
			detail: "detail" in v.result ? v.result.detail : undefined,
			certificationDigest: "certification" in v.result ? v.result.certification?.digest : undefined,
			checks: "certification" in v.result ? v.result.certification?.checks : undefined,
		})),
		ledger: port.ledger,
		peakConcurrency: port.peakConcurrency,
		budget: state.budget,
		outcome,
	};
}
