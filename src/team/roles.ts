// The fixed specialist roles of the team (DD-03 §1): Planner, Retrieval
// specialist, Code Reviewer and Security Reviewer. Each is one or more
// controlled model calls through the ControlledModelPort with a trusted
// system prompt and one reviewed structured-output tool; the answer is the
// tool call's arguments, validated against the schema, and nothing else —
// free text is not a plan, a finding or a citation. A specialist reads the
// frozen revision it is given and returns typed output; it writes no source
// and approves nothing. An answer outside the schema is asked for again
// within the role's own call budget (a new call, a new admission), never by
// an SDK retry.
import { readFileSync } from "node:fs";
import path from "node:path";
import type { RelayMessage } from "../adapters/sidecar.js";
import type { Allowance } from "../budget.js";
import { parseStrictObject, validateSchema } from "../contracts.js";
import { BudgetExhaustedError, type ControlledModelPort, type ModelCallResult, type Role } from "../port/model.js";
import type { SealedSource } from "../source.js";
import { type ReviewedTool, specialistTools, toolDefinition } from "./tools.js";

export interface Plan {
	componentId: string;
	puckType: string;
	packageName: string;
	version: string;
	steps: Array<{ id: string; title: string; files: string[]; detail: string }>;
}

export interface Finding {
	id: string;
	severity: "blocker" | "major" | "minor";
	file: string;
	line?: number;
	summary: string;
	remediation: string;
}

export interface Findings {
	verdict: "pass" | "repair";
	findings: Finding[];
}

export interface Evidence {
	id: string;
	source: string;
	text: string;
}

export type RetrievalResult =
	| { status: "evidence"; evidence: Evidence[] }
	| { status: "insufficient_evidence"; reason: string };

/** The trusted retrieval port (Knowledge through the sidecar's expert relay, P16); unavailable in this build. */
export interface RetrievalPort {
	retrieve(question: string): Promise<RetrievalResult>;
}

export interface Prompts {
	planner: string;
	retrieval: string;
	coder: string;
	code_reviewer: string;
	security_reviewer: string;
}

/** Loads the five trusted prompts from the explicit agent directory (agent/team/prompts). */
export function loadPrompts(agentDir: string): Prompts {
	const read = (name: string) => {
		const text = readFileSync(path.join(agentDir, "team", "prompts", `${name}.md`), "utf8");
		if (text.trim().length === 0) throw new Error(`trusted prompt ${name} is empty`);
		return text;
	};
	return {
		planner: read("planner"),
		retrieval: read("retrieval"),
		coder: read("coder"),
		code_reviewer: read("code_reviewer"),
		security_reviewer: read("security_reviewer"),
	};
}

export interface SpecialistCall<T> {
	role: Role;
	systemPrompt: string;
	user: string;
	tool: ReviewedTool;
	maxOutputTokens: number;
	exposure: { currency: string; amount: string };
	remaining: () => Allowance;
	nextOrdinal: () => number;
	/** Called for every call the specialist made (accounting). */
	onResult: (r: ModelCallResult) => void;
	/** Refines the validated arguments into the typed output, or returns a reason to ask again. */
	accept: (args: Record<string, unknown>) => { ok: true; value: T } | { ok: false; reason: string };
}

export class SpecialistOutputError extends Error {
	constructor(
		readonly role: Role,
		message: string,
	) {
		super(message);
		this.name = "SpecialistOutputError";
	}
}

/**
 * Runs a specialist: at most the role's remaining calls, each a fresh
 * admission; the first answer that is exactly one call of the reviewed tool
 * with schema-valid arguments the acceptor takes is the output.
 */
export async function runSpecialist<T>(
	port: ControlledModelPort,
	call: SpecialistCall<T>,
	signal?: AbortSignal,
): Promise<{ value: T; calls: number }> {
	const messages: RelayMessage[] = [
		{ role: "system", content: call.systemPrompt },
		{ role: "user", content: call.user },
	];
	const tools = [toolDefinition(call.tool)];
	let calls = 0;
	let lastReason = "";
	if (call.remaining().calls < 1)
		throw new BudgetExhaustedError(`${call.role}: no call left in the allowance reserved for it`);
	while (call.remaining().calls > 0) {
		const result = await port.call(
			{
				role: call.role,
				ordinal: call.nextOrdinal(),
				messages,
				tools,
				maxOutputTokens: call.maxOutputTokens,
				exposure: call.exposure,
				remaining: call.remaining(),
			},
			{ signal },
		);
		calls++;
		call.onResult(result);
		const reason = (() => {
			if (result.toolCalls.length !== 1)
				return `expected exactly one ${call.tool.name} call, got ${result.toolCalls.length}`;
			const tc = result.toolCalls[0];
			if (!tc || tc.name !== call.tool.name)
				return `expected a ${call.tool.name} call, got ${tc?.name} (call ${result.callId}, ${result.frames} frames: ${result.streamed.map((f) => (f.type === "tool_call" ? `tool_call:${f.toolCall?.name}` : f.type)).join(",")})`;
			let args: Record<string, unknown>;
			try {
				args = parseStrictObject(tc.arguments, `${call.tool.name} arguments`);
			} catch (err) {
				return (err as Error).message;
			}
			const problem = validateSchema(call.tool.inputSchema, args);
			if (problem) return `${call.tool.name} arguments: ${problem}`;
			const accepted = call.accept(args);
			if (!accepted.ok) return accepted.reason;
			return { value: accepted.value };
		})();
		if (typeof reason !== "string") return { value: reason.value, calls };
		lastReason = reason;
		// The round trip is kept in the history so the next call sees its own
		// answer and the correction; the tool result is the correction text.
		const tc = result.toolCalls[0];
		if (tc) {
			messages.push({
				role: "assistant",
				content: result.text,
				toolCalls: [{ toolCallId: tc.toolCallId, name: tc.name, arguments: tc.arguments }],
			});
			messages.push({
				role: "tool",
				toolCallId: tc.toolCallId,
				content: `Rejected: ${reason}. Call ${call.tool.name} again with arguments that satisfy its schema.`,
			});
		} else {
			messages.push({ role: "assistant", content: result.text || "(no answer)" });
			messages.push({ role: "user", content: `Rejected: ${reason}. Answer only by calling ${call.tool.name}.` });
		}
	}
	throw new SpecialistOutputError(
		call.role,
		`${call.role}: no schema-valid ${call.tool.name} within the role's call budget (${lastReason})`,
	);
}

export const tool = (name: string): ReviewedTool => {
	const t = specialistTools.find((x) => x.name === name);
	if (!t) throw new Error(`no reviewed tool ${name}`);
	return t;
};

export interface Brief {
	componentId: string;
	puckType: string;
	packageName: string;
	version: string;
	requirements: string;
}

export function planUser(brief: Brief, sourceRevision: string): string {
	return [
		"Frozen brief (JSON):",
		JSON.stringify(brief, null, 2),
		`Source revision to produce: ${sourceRevision}.`,
		"Produce the plan with submit_plan.",
	].join("\n\n");
}

/** The frozen revision as reviewers read it: every sealed file's text, bounded. */
export function renderSource(sealedDir: string, source: SealedSource, maxBytes: number): string {
	let out = "";
	for (const f of source.files) {
		const size = Number(f.sizeBytes);
		const bytes = readFileSync(path.join(sealedDir, "source", f.path));
		const text = bytes.toString("utf8");
		const binary = text.includes("�");
		const block = binary
			? `--- ${f.path} (${size} bytes, binary, ${f.digest}) ---\n`
			: `--- ${f.path} (${size} bytes, ${f.digest}) ---\n${text}\n`;
		if (out.length + block.length > maxBytes) {
			out += `--- ${f.path} omitted: the review bound of ${maxBytes} bytes is reached ---\n`;
			break;
		}
		out += block;
	}
	return out;
}

export function reviewUser(plan: Plan, revision: string, rendered: string): string {
	return [
		`Frozen source revision ${revision}. Review it against the plan and report with submit_findings.`,
		"Plan (JSON):",
		JSON.stringify(plan, null, 2),
		"Files:",
		rendered,
	].join("\n\n");
}

export function repairUser(
	findings: Finding[],
	validator: { failureCode?: string; detail?: string } | undefined,
	revision: string,
): string {
	const lines = [
		`Repair round for source revision ${revision}. Change only what these findings require and keep the rest of the source as it is.`,
	];
	if (validator?.failureCode)
		lines.push(`Independent validator: ${validator.failureCode}${validator.detail ? ` — ${validator.detail}` : ""}`);
	for (const f of findings)
		lines.push(
			`- [${f.severity}] ${f.id} ${f.file}${f.line ? `:${f.line}` : ""}: ${f.summary} Remediation: ${f.remediation}`,
		);
	lines.push("When the repairs are written, answer with one short sentence.");
	return lines.join("\n");
}
