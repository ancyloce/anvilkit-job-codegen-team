// ControlledModelPort (DD-03 §2/§6, delivery.md P12-02): the one way any
// role of the team — the specialists in the trusted coordinator, the Pi
// coder in the candidate, and every summary, compaction or repair call they
// make — reaches a model. A call is one request on the access sidecar's
// controlled model relay: the sidecar binds the scope Control confirms now,
// the Model Proxy asks Control for the single-use admission and performs the
// one physical send. This port never retries a send, never falls back and
// never chooses a route: a transport failure before the final frame is
// reentered once under the same call identity and bytes (the Proxy replays
// its record or attaches to the live send; a reentry can create no
// permission), and an outcome the record does not establish is an uncertain
// effect the caller must stop on. Budgets are enforced before a send from
// the allowance the caller states (src/budget.ts: every call at the
// exposure Control reserves for one send; the graph state carries the
// accounting; Control's ledger is the authority on cost).
import { appendFileSync } from "node:fs";
import type {
	Money,
	RelayMessage,
	RelayOptions,
	RelayRequest,
	RelayResult,
	RelayToolDefinition,
	StreamFrame,
	Usage,
} from "../adapters/sidecar.js";
import { SidecarError } from "../adapters/sidecar.js";
import { type Allowance, moneyAmount } from "../budget.js";

export type Role = "planner" | "retrieval" | "coder" | "code_reviewer" | "security_reviewer";

export class BudgetExhaustedError extends Error {
	readonly code = "BUDGET_EXHAUSTED";
	constructor(message: string) {
		super(message);
		this.name = "BudgetExhaustedError";
	}
}

export class DeadlineExceededError extends Error {
	readonly code = "DEADLINE_EXCEEDED";
	constructor(message: string) {
		super(message);
		this.name = "DeadlineExceededError";
	}
}

/** The call was refused before any send (the sidecar's or the Proxy's error envelope). */
export class ModelCallRefusedError extends Error {
	constructor(
		readonly code: string,
		readonly status: number,
		message: string,
	) {
		super(message);
		this.name = "ModelCallRefusedError";
	}
}

/** The call ended definitely: a failed or canceled send, or a cancellation before any send (no resend). */
export class ModelCallFailedError extends Error {
	constructor(
		readonly outcome: "failed" | "canceled",
		readonly code: string,
		message: string,
	) {
		super(message);
		this.name = "ModelCallFailedError";
	}
}

/** The outcome of the send is not established: nothing may be resent under this identity. */
export class EffectUncertainError extends Error {
	readonly code = "EFFECT_UNCERTAIN";
	constructor(
		readonly callId: string,
		message: string,
	) {
		super(message);
		this.name = "EffectUncertainError";
	}
}

export interface ModelCallInput {
	role: Role;
	/** The ordinal of this call within its role; the caller keeps it deterministic across a restart. */
	ordinal: number;
	messages: RelayMessage[];
	tools?: RelayToolDefinition[];
	maxOutputTokens: number;
	/** The exposure this call declares: what Control reserves for the send (the per-send exposure). */
	exposure: Money;
	remaining: Allowance;
}

export interface ModelToolCall {
	toolCallId: string;
	name: string;
	arguments: string;
}

export interface ModelCallResult {
	callId: string;
	role: Role;
	text: string;
	toolCalls: ModelToolCall[];
	usage?: Usage;
	exposure: Money;
	frames: number;
	/** The relay was asked a second time under the same identity after a cut stream. */
	reentered: boolean;
	/** The frames the Proxy answered with (the transport evidence of the call). */
	streamed: StreamFrame[];
}

export interface LedgerEntry {
	callId: string;
	role: Role;
	outcome: "succeeded" | "failed" | "canceled" | "unknown" | "refused";
	code?: string;
	usage?: Usage;
	exposure: Money;
	frames: number;
	reentered: boolean;
	at: string;
}

export type RelayFn = (req: RelayRequest, options?: RelayOptions) => Promise<RelayResult>;

export interface ControlledModelPortOptions {
	relay: RelayFn;
	routeId: string;
	/** The absolute deadline every call is bounded by (the attempt's; never reset). */
	deadline: Date;
	/** Call identities are `${callIdPrefix}:${role}:${ordinal}`. */
	callIdPrefix: string;
	/** At most this many calls in flight through this port. */
	maxConcurrent: number;
	/** The margin before the deadline within which no new call starts. */
	deadlineMarginMs?: number;
	/** Where the ledger lines go (append); undefined keeps them in memory only. */
	ledgerPath?: string;
	now?: () => Date;
	onFrame?: (callId: string, frame: StreamFrame) => void;
}

export class ControlledModelPort {
	readonly ledger: LedgerEntry[] = [];
	/**
	 * Calls whose outcome is not established (DD-02: reconciled under the
	 * original identity, never replaced). While one exists, this port admits
	 * no other call identity — the same identity may be asked again, which
	 * is how the record is reconciled; a new ordinal, a retry under another
	 * name or a fallback route would bypass it.
	 */
	private readonly unreconciledCalls = new Set<string>();
	private inFlight = 0;
	private peakInFlight = 0;
	private readonly waiters: Array<() => void> = [];
	private readonly now: () => Date;

	constructor(private readonly options: ControlledModelPortOptions) {
		if (!Number.isInteger(options.maxConcurrent) || options.maxConcurrent < 1)
			throw new Error("maxConcurrent must be at least 1");
		this.now = options.now ?? (() => new Date());
	}

	/** The highest number of calls that were in flight at once (the parallelism evidence). */
	get peakConcurrency(): number {
		return this.peakInFlight;
	}

	callId(role: Role, ordinal: number): string {
		return `${this.options.callIdPrefix}:${role}:${ordinal}`;
	}

	/**
	 * What a role has spent through this port: one allowance per call
	 * identity that was asked of the relay (the ledger records it whatever
	 * its outcome — a refusal, a cut or unknown stream and a success alike
	 * hold or held the declared exposure), never a call refused before that.
	 * The ledger keeps every observation of a call — a reentered stream, the
	 * reconciliation of an unknown record, a replay under the same identity
	 * — but they are the same call: it is charged once, at its exposure.
	 */
	spent(role: Role): { calls: number; exposure: bigint } {
		const exposures = new Map<string, bigint>();
		for (const l of this.ledger) if (l.role === role) exposures.set(l.callId, moneyAmount(l.exposure));
		let exposure = 0n;
		for (const e of exposures.values()) exposure += e;
		return { calls: exposures.size, exposure };
	}

	private async acquire(): Promise<void> {
		if (this.inFlight < this.options.maxConcurrent) {
			this.inFlight++;
			this.peakInFlight = Math.max(this.peakInFlight, this.inFlight);
			return;
		}
		await new Promise<void>((resolve) => this.waiters.push(resolve));
		this.inFlight++;
		this.peakInFlight = Math.max(this.peakInFlight, this.inFlight);
	}

	private release(): void {
		this.inFlight--;
		const next = this.waiters.shift();
		if (next) next();
	}

	/** The identity of a call whose outcome is not established, if any. */
	unreconciled(): string | undefined {
		return this.unreconciledCalls.values().next().value;
	}

	private record(entry: LedgerEntry): void {
		this.ledger.push(entry);
		if (entry.outcome === "unknown") this.unreconciledCalls.add(entry.callId);
		else this.unreconciledCalls.delete(entry.callId);
		if (this.options.ledgerPath) appendFileSync(this.options.ledgerPath, `${JSON.stringify(entry)}\n`);
	}

	/** Checks the allowance and the deadline; throws before anything is sent. */
	admit(input: ModelCallInput): void {
		const { remaining, exposure } = input;
		if (remaining.calls < 1) throw new BudgetExhaustedError(`${input.role}: no call left in the role budget`);
		if (remaining.aggregateCalls < 1)
			throw new BudgetExhaustedError(`${input.role}: no call left in the aggregate budget`);
		if (exposure.currency !== remaining.exposure.currency || exposure.currency !== remaining.aggregateExposure.currency)
			throw new BudgetExhaustedError(`${input.role}: exposure currency ${exposure.currency} is not the budget's`);
		if (moneyAmount(exposure) <= 0n)
			throw new BudgetExhaustedError(`${input.role}: a call must declare a positive exposure`);
		if (moneyAmount(exposure) > moneyAmount(remaining.exposure))
			throw new BudgetExhaustedError(
				`${input.role}: exposure ${exposure.amount} exceeds the role's remaining ${remaining.exposure.amount}`,
			);
		if (moneyAmount(exposure) > moneyAmount(remaining.aggregateExposure))
			throw new BudgetExhaustedError(
				`${input.role}: exposure ${exposure.amount} exceeds the aggregate remaining ${remaining.aggregateExposure.amount}`,
			);
		if (input.maxOutputTokens < 1) throw new BudgetExhaustedError(`${input.role}: maxOutputTokens must be positive`);
		if (input.messages.length < 1 || input.messages.length > 512)
			throw new ModelCallRefusedError(
				"INVALID_ARGUMENT",
				400,
				`${input.role}: ${input.messages.length} messages are outside the contract's 1..512`,
			);
		this.checkDeadline(input.role);
	}

	private checkDeadline(role: Role): void {
		const margin = this.options.deadlineMarginMs ?? 0;
		if (this.now().getTime() + margin >= this.options.deadline.getTime())
			throw new DeadlineExceededError(
				`${role}: the deadline ${this.options.deadline.toISOString()} leaves no time for a call`,
			);
	}

	/** No identity other than an unreconciled one is admitted while it exists. */
	private fence(callId: string, role: Role): void {
		const pending = this.unreconciled();
		if (pending !== undefined && !this.unreconciledCalls.has(callId))
			throw new EffectUncertainError(
				pending,
				`${role}: ${callId} is not admitted while the outcome of ${pending} is not established`,
			);
	}

	async call(input: ModelCallInput, options: { signal?: AbortSignal } = {}): Promise<ModelCallResult> {
		const callId = this.callId(input.role, input.ordinal);
		this.fence(callId, input.role);
		this.admit(input);
		const req: RelayRequest = {
			callId,
			routeId: this.options.routeId,
			messages: input.messages,
			maxOutputTokens: input.maxOutputTokens,
			maxExposure: input.exposure,
			// Every call states the attempt's absolute deadline (never reset, so
			// a restarted run states the same bytes and reenters its records);
			// the route's max_deadline must cover the profile's deadline.
			deadline: this.options.deadline.toISOString(),
		};
		if (input.tools && input.tools.length > 0) req.tools = input.tools;
		await this.acquire();
		try {
			// The slot may have been waited for: what held before the queue is
			// established again immediately before the relay is asked — an
			// identity whose outcome became unknown meanwhile fences this one,
			// the deadline may have passed, the caller may have canceled. A
			// refusal here asked nothing of the relay (no ledger line, nothing
			// held) and releases the slot below.
			this.fence(callId, input.role);
			this.checkDeadline(input.role);
			if (options.signal?.aborted)
				throw new ModelCallFailedError("canceled", "CANCELED", `${input.role}: ${callId} was canceled before its send`);
			let reentered = false;
			let result: RelayResult;
			try {
				result = await this.relayOnce(req, options.signal);
			} catch (err) {
				if (err instanceof SidecarError) {
					this.record({
						callId,
						role: input.role,
						outcome: "refused",
						code: err.code,
						exposure: input.exposure,
						frames: 0,
						reentered,
						at: this.now().toISOString(),
					});
					throw new ModelCallRefusedError(err.code, err.status, `${input.role}: ${err.message}`);
				}
				if (options.signal?.aborted) {
					this.record({
						callId,
						role: input.role,
						outcome: "unknown",
						code: "ABORTED",
						exposure: input.exposure,
						frames: 0,
						reentered,
						at: this.now().toISOString(),
					});
					throw new EffectUncertainError(
						callId,
						`${input.role}: the call was abandoned; its outcome is the Proxy's record`,
					);
				}
				// The stream was cut before a final frame: ask the relay again
				// under the same identity and bytes. The Proxy answers its
				// record or the live send; nothing is sent again.
				reentered = true;
				try {
					result = await this.relayOnce(req, options.signal);
				} catch (again) {
					const code = again instanceof SidecarError ? again.code : "TRANSPORT";
					this.record({
						callId,
						role: input.role,
						outcome: "unknown",
						code,
						exposure: input.exposure,
						frames: 0,
						reentered,
						at: this.now().toISOString(),
					});
					throw new EffectUncertainError(
						callId,
						`${input.role}: the outcome of ${callId} is not established (${(again as Error).message})`,
					);
				}
			}
			return this.settle(callId, input, result, reentered);
		} finally {
			this.release();
		}
	}

	private relayOnce(req: RelayRequest, signal: AbortSignal | undefined): Promise<RelayResult> {
		const onFrame = this.options.onFrame;
		return this.options.relay(req, { signal, onFrame: onFrame ? (f) => onFrame(req.callId, f) : undefined });
	}

	private settle(callId: string, input: ModelCallInput, result: RelayResult, reentered: boolean): ModelCallResult {
		const at = this.now().toISOString();
		const final = result.final;
		if (!final) {
			this.record({
				callId,
				role: input.role,
				outcome: "unknown",
				code: "STREAM_CUT",
				exposure: input.exposure,
				frames: result.frames.length,
				reentered,
				at,
			});
			throw new EffectUncertainError(callId, `${input.role}: the stream of ${callId} ended without a final frame`);
		}
		let usage: Usage | undefined;
		let text = "";
		const toolCalls: ModelToolCall[] = [];
		for (const f of result.frames) {
			if (f.type === "text" && f.text) text += f.text;
			if (f.type === "tool_call" && f.toolCall) {
				if (f.toolCall.arguments === undefined)
					throw new ModelCallFailedError(
						"failed",
						"INVALID_ARGUMENT",
						`${input.role}: tool call ${f.toolCall.toolCallId} carries no arguments`,
					);
				toolCalls.push({ toolCallId: f.toolCall.toolCallId, name: f.toolCall.name, arguments: f.toolCall.arguments });
			}
			if (f.type === "usage" && f.usage) usage = f.usage;
		}
		const outcome = final.outcome ?? (final.type === "done" ? "succeeded" : "unknown");
		if (final.type === "error" || outcome !== "succeeded") {
			const code = final.errorCode ?? "UPSTREAM_FAILED";
			this.record({
				callId,
				role: input.role,
				outcome,
				code,
				usage,
				exposure: input.exposure,
				frames: result.frames.length,
				reentered,
				at,
			});
			if (outcome === "unknown")
				throw new EffectUncertainError(callId, `${input.role}: ${callId} ended unknown (${code})`);
			throw new ModelCallFailedError(
				outcome === "canceled" ? "canceled" : "failed",
				code,
				`${input.role}: ${callId} ${outcome} (${code})`,
			);
		}
		this.record({
			callId,
			role: input.role,
			outcome: "succeeded",
			usage,
			exposure: input.exposure,
			frames: result.frames.length,
			reentered,
			at,
		});
		return {
			callId,
			role: input.role,
			text,
			toolCalls,
			usage,
			exposure: input.exposure,
			frames: result.frames.length,
			reentered,
			streamed: result.frames,
		};
	}
}

/** The frames of one recorded call, replayed as the Proxy would (test doubles and evidence readers share it). */
export function isFinalFrame(f: StreamFrame): boolean {
	return f.type === "done" || f.type === "error";
}
