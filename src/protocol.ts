// The coordinator's side of the codegen Job's process protocol
// (urn:anvilkit:codegen-protocol:v1, owned by anvilkit-agent-contracts at
// jobs/codegen/protocol.schema.json; contract/ holds the verbatim copy
// tools/sync-protocol.sh verifies): newline-delimited JSON on the
// coordinator's stdio with the Go supervisor, and the team result document.
// What the coordinator writes is validated against the schema before it is
// written; what the supervisor answers is parsed strictly (one object, no
// duplicate member, bounded) and validated before anything builds on it.
import { readFileSync } from "node:fs";
import path from "node:path";
import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";
import { packageRoot, parseStrictObject } from "./contracts.js";

export const protocolSchemaId = "urn:anvilkit:codegen-protocol:v1";
export const protocolVersion = 1;
export const maxLineBytes = 65536;
export const maxResultBytes = 262144;

/** Refusals after which nothing is sealed or submitted and no round runs. */
export const finalRefusals: ReadonlySet<string> = new Set(["CANDIDATE_NOT_RUN", "STOP_NOT_ESTABLISHED"]);

export interface RunCandidate {
	type: "run-candidate";
	protocolVersion: 1;
	requestId: number;
	round: number;
	roundDir: string;
}

export type StopReason = "exited" | "timeout" | "canceled";

export interface CandidateEnded {
	type: "candidate-ended";
	protocolVersion: 1;
	requestId: number;
	round: number;
	stop: StopReason;
	exit: number | null;
	signal?: string;
	descendantsStopped: number;
	startedAt: string;
	endedAt: string;
}

export interface Refused {
	type: "refused";
	protocolVersion: 1;
	requestId: number;
	round: number;
	code: "ROUND_NOT_NEW" | "ROUND_DIR_INVALID" | "TEAM_ENDED" | "CANDIDATE_NOT_RUN" | "STOP_NOT_ESTABLISHED";
	reason: string;
}

export type Answer = CandidateEnded | Refused;

export type TeamOutcomeKind =
	| "certified"
	| "repairable"
	| "invalid"
	| "infrastructure_failed"
	| "validation_unavailable"
	| "budget_exhausted"
	| "deadline"
	| "model_denied"
	| "effect_uncertain"
	| "canceled"
	| "failed";

export interface TeamResult {
	protocolVersion: 1;
	outcome: { kind: TeamOutcomeKind; failureCode?: string; detail: string; round?: number };
	verdict: "certified" | "repairable" | "invalid" | "infrastructure_failed" | "canceled";
	failureCode: string;
	stageId?: string;
	existing?: boolean;
	counters?: { rounds: number; reviewRounds: number; repairs: number };
	calls?: number;
	error?: string;
}

/** A message outside the protocol: the run ends, nothing builds on it. */
export class ProtocolViolationError extends Error {
	constructor(message: string) {
		super(`process protocol: ${message}`);
		this.name = "ProtocolViolationError";
	}
}

let validators: Record<"runCandidate" | "answer" | "teamResult", ValidateFunction> | undefined;

/** The contract copy shipped with this package (contract/protocol.schema.json). */
export function protocolSchema(): Record<string, unknown> {
	return JSON.parse(readFileSync(path.join(packageRoot, "contract", "protocol.schema.json"), "utf8")) as Record<
		string,
		unknown
	>;
}

function validator(name: "runCandidate" | "answer" | "teamResult"): ValidateFunction {
	if (!validators) {
		// strictRequired is off as for the jobs contract: a then/required
		// clause beside a properties declaration states a conditional member.
		const ajv = new Ajv2020({ strict: true, strictRequired: false, allErrors: false, allowUnionTypes: true });
		ajv.addSchema(protocolSchema());
		const get = (def: string) => {
			const v = ajv.getSchema(`${protocolSchemaId}#/$defs/${def}`);
			if (!v) throw new Error(`the protocol contract has no ${def}`);
			return v;
		};
		validators = { runCandidate: get("runCandidate"), answer: get("answer"), teamResult: get("teamResult") };
	}
	return validators[name];
}

/** Loads and compiles the contract copy: run at start, so a missing or broken contract refuses the run before any send. */
export function loadProtocolContract(): void {
	validator("runCandidate");
}

function problemOf(v: ValidateFunction): string {
	const e = v.errors?.[0];
	return e ? `${e.instancePath || "/"} ${e.message ?? "invalid"}` : "invalid";
}

/** One request line (with its newline); a request outside the contract is a defect of this package. */
export function encodeRequest(req: RunCandidate): string {
	const v = validator("runCandidate");
	if (!v(req)) throw new ProtocolViolationError(`the request is outside the contract: ${problemOf(v)}`);
	const line = `${JSON.stringify(req)}\n`;
	if (Buffer.byteLength(line) > maxLineBytes) throw new ProtocolViolationError("the request exceeds the line bound");
	return line;
}

/** Decodes one answer line (without its newline). */
export function decodeAnswer(line: string): Answer {
	if (Buffer.byteLength(line) + 1 > maxLineBytes) throw new ProtocolViolationError("an answer exceeds the line bound");
	let raw: Record<string, unknown>;
	try {
		raw = parseStrictObject(line, "answer");
	} catch (err) {
		throw new ProtocolViolationError((err as Error).message);
	}
	const v = validator("answer");
	if (!v(raw)) throw new ProtocolViolationError(`the answer is outside the contract: ${problemOf(v)}`);
	return raw as unknown as Answer;
}

/** The team result document's bytes; a result outside the contract is a defect of this package. */
export function encodeResult(result: TeamResult): string {
	const v = validator("teamResult");
	if (!v(result)) throw new ProtocolViolationError(`the team result is outside the contract: ${problemOf(v)}`);
	const text = JSON.stringify(result);
	if (Buffer.byteLength(text) > maxResultBytes) throw new ProtocolViolationError("the team result exceeds its bound");
	return text;
}
