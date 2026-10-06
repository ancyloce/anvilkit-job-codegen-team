// The access sidecar's routes as the team uses them (DD-03 §5, P09c/P11):
// the trusted coordinator over trusted.sock (scope, transfers, results, the
// accepted stage, the controlled model relay) and the Pi candidate over
// candidate.sock (the controlled model relay, the permitted inputs). Every
// request opens its own connection, sends one request and closes, so no
// descriptor is ever delegated and a connection never outlives its request.
// The relay's answer is an event stream of the Model Proxy's frames
// (openapi/model-proxy.yaml StreamFrame), read with eventsource-parser.
import http from "node:http";
import { createParser } from "eventsource-parser";
import { parseStrictObject } from "../contracts.js";

/** One message of the model call history (openapi/model-proxy.yaml Message). */
export interface RelayMessage {
	role: "system" | "user" | "assistant" | "tool";
	content: string;
	toolCallId?: string;
	toolCalls?: RelayToolCall[];
}

export interface RelayToolCall {
	toolCallId: string;
	name: string;
	arguments: string;
}

export interface RelayToolDefinition {
	name: string;
	description?: string;
	inputSchemaDigest: string;
}

export interface Money {
	currency: string;
	amount: string;
}

/** What a caller may state on the relay: identity, route, content, bounds. */
export interface RelayRequest {
	callId: string;
	routeId: string;
	messages: RelayMessage[];
	tools?: RelayToolDefinition[];
	maxOutputTokens: number;
	maxExposure: Money;
	deadline?: string;
}

export interface Usage {
	inputUnits: string;
	outputUnits: string;
	reasoningUnits: string;
	cachedInputUnits: string;
}

export type FrameType = "admitted" | "text" | "tool_call" | "usage" | "done" | "error";
export type Outcome = "succeeded" | "failed" | "canceled" | "unknown";

export interface StreamFrame {
	callId: string;
	sequence: string;
	type: FrameType;
	text?: string;
	toolCall?: { toolCallId: string; name: string; argumentsDigest: string; arguments?: string };
	usage?: Usage;
	outcome?: Outcome;
	errorCode?: string;
}

/** A refusal answered by the sidecar or relayed from the Proxy (its error envelope). */
export class SidecarError extends Error {
	constructor(
		readonly status: number,
		readonly code: string,
		readonly reason: string,
		readonly retryable = false,
	) {
		super(`sidecar answered ${status} ${code}${reason ? ` ${reason}` : ""}`);
		this.name = "SidecarError";
	}
}

export interface Scope {
	tenantId: string;
	operationId: string;
	attemptId: string;
	instanceId: string;
	current: boolean;
	profileId: string;
	executionEpoch: string;
	recoveryEpoch: string;
	launchKey: string;
	deadline: string;
}

export interface Transfer {
	handle: string;
	transferId: string;
	class: string;
	digest: string;
	sizeBytes: string;
	objectVersion: string;
	state: string;
	existing: boolean;
}

export interface Stage {
	stageId: string;
	resultDigest: string;
	existing: boolean;
}

/** The accepted stage of this attempt as Control records it (GET /v1/results). */
export interface AcceptedStage {
	stageId: string;
	attemptId: string;
	instanceId: string;
	verdict: string;
	failureCode?: string;
	resultDigest: string;
	observerIdentity: string;
	profileId: string;
	executionEpoch: string;
	recoveryEpoch: string;
	artifacts: AcceptedArtifact[];
}

export interface AcceptedArtifact {
	handle: string;
	class: string;
	digest: string;
	sizeBytes: string;
	transferId: string;
	objectVersion: string;
}

const frameTypes = new Set<FrameType>(["admitted", "text", "tool_call", "usage", "done", "error"]);

/** Parses one frame of the stream strictly: the contract's members only, the call named, the type known. */
export function parseFrame(data: string, callId: string): StreamFrame {
	const raw = parseStrictObject(data, "stream frame");
	const known = new Set(["callId", "sequence", "type", "text", "toolCall", "usage", "outcome", "errorCode"]);
	for (const k of Object.keys(raw)) if (!known.has(k)) throw new Error(`stream frame: unknown member ${k}`);
	const f = raw as unknown as StreamFrame;
	if (f.callId !== callId) throw new Error(`stream frame names call ${f.callId}, expected ${callId}`);
	if (typeof f.sequence !== "string" || !/^(0|[1-9][0-9]{0,19})$/.test(f.sequence))
		throw new Error("stream frame: sequence is not a sequence");
	if (!frameTypes.has(f.type)) throw new Error(`stream frame: unknown type ${String(f.type)}`);
	return f;
}

export interface RelayOptions {
	signal?: AbortSignal;
	/** Called for every frame as it arrives, before the call settles. */
	onFrame?: (frame: StreamFrame) => void;
}

export interface RelayResult {
	frames: StreamFrame[];
	/** The final frame (done or error); undefined when the stream ended without one. */
	final?: StreamFrame;
}

/** One HTTP request over a unix socket; the answer's status, headers and body (bounded). */
async function request(
	socketPath: string,
	method: string,
	path: string,
	headers: Record<string, string>,
	body: Buffer | undefined,
	timeoutMs: number,
	maxBody: number,
): Promise<{ status: number; contentType: string; body: Buffer }> {
	return new Promise((resolve, reject) => {
		const req = http.request(
			{ socketPath, method, path, headers: { ...headers, connection: "close" }, agent: false, timeout: timeoutMs },
			(res) => {
				const chunks: Buffer[] = [];
				let size = 0;
				res.on("data", (c: Buffer) => {
					size += c.length;
					if (size > maxBody) {
						res.destroy(new Error(`sidecar answer exceeds ${maxBody} bytes`));
						return;
					}
					chunks.push(c);
				});
				res.on("error", reject);
				res.on("end", () =>
					resolve({
						status: res.statusCode ?? 0,
						contentType: res.headers["content-type"] ?? "",
						body: Buffer.concat(chunks),
					}),
				);
			},
		);
		req.on("timeout", () => req.destroy(new Error(`sidecar ${method} ${path}: timeout after ${timeoutMs} ms`)));
		req.on("error", reject);
		if (body) req.setHeader("content-length", body.length);
		req.end(body);
	});
}

function refusal(status: number, body: Buffer): SidecarError {
	let code = "UNKNOWN";
	let reason = "";
	let retryable = false;
	try {
		const raw = JSON.parse(body.toString("utf8")) as Record<string, unknown>;
		// The sidecar's own envelope is {code, reason}; the Proxy's relayed
		// envelope is {error: {code, message, requestId, retryable}}.
		const err = (raw.error as Record<string, unknown> | undefined) ?? raw;
		if (typeof err.code === "string") code = err.code;
		if (typeof err.reason === "string") reason = err.reason;
		if (typeof err.message === "string") reason = err.message;
		if (typeof err.retryable === "boolean") retryable = err.retryable;
	} catch {
		// not JSON: the status alone
	}
	return new SidecarError(status, code, reason, retryable);
}

export interface SidecarClientOptions {
	/** Bound of one plain request (scope, transfer, result). */
	requestTimeoutMs?: number;
}

/** The client of one socket (trusted.sock for the coordinator, candidate.sock for the Pi coder). */
export class SidecarClient {
	private readonly requestTimeoutMs: number;

	constructor(
		readonly socketPath: string,
		options: SidecarClientOptions = {},
	) {
		this.requestTimeoutMs = options.requestTimeoutMs ?? 60_000;
	}

	private async json<T>(method: string, path: string, headers: Record<string, string>, body?: Buffer): Promise<T> {
		const r = await request(this.socketPath, method, path, headers, body, this.requestTimeoutMs, 4 << 20);
		if (r.status < 200 || r.status > 299) throw refusal(r.status, r.body);
		return JSON.parse(r.body.toString("utf8")) as T;
	}

	/** GET /v1/scope: the scope Control confirms now (trusted socket). */
	async scope(): Promise<{ scope: Scope; launchId: string; inputs: string[] }> {
		return this.json("GET", "/v1/scope", {});
	}

	/** GET /v1/inputs/{name}: a permitted input (candidate socket). */
	async input(name: string): Promise<Buffer> {
		const r = await request(
			this.socketPath,
			"GET",
			`/v1/inputs/${name}`,
			{},
			undefined,
			this.requestTimeoutMs,
			16 << 20,
		);
		if (r.status !== 200) throw refusal(r.status, r.body);
		return r.body;
	}

	/** POST /v1/transfers: the scoped upload of bytes the trusted side produced (trusted socket). */
	async upload(artifactClass: string, mediaType: string, body: Buffer): Promise<Transfer> {
		return this.json("POST", "/v1/transfers", { "x-anvilkit-class": artifactClass, "content-type": mediaType }, body);
	}

	/** POST /v1/results: the result manifest for acceptance (trusted socket). */
	async submit(verdict: string, failureCode: string, observerIdentity: string, manifest: Buffer): Promise<Stage> {
		const body = Buffer.from(
			JSON.stringify({ verdict, failureCode, observerIdentity, manifest: JSON.parse(manifest.toString("utf8")) }),
		);
		return this.json("POST", "/v1/results", { "content-type": "application/json" }, body);
	}

	/**
	 * GET /v1/stages/{attemptId}: the accepted stage of another attempt of
	 * this operation (P13-04 cross-attempt recovery; Control checks the
	 * relationship), or undefined when none is accepted (trusted socket).
	 */
	async priorStage(attemptId: string): Promise<AcceptedStage | undefined> {
		if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(attemptId)) throw new Error(`attempt id ${attemptId} is not an id`);
		const r = await request(
			this.socketPath,
			"GET",
			`/v1/stages/${attemptId}`,
			{},
			undefined,
			this.requestTimeoutMs,
			1 << 20,
		);
		if (r.status === 404) return undefined;
		if (r.status !== 200) throw refusal(r.status, r.body);
		return JSON.parse(r.body.toString("utf8")) as AcceptedStage;
	}

	/** GET /v1/results: the accepted stage of this attempt, or undefined when none is accepted yet (trusted socket). */
	async acceptedStage(): Promise<AcceptedStage | undefined> {
		const r = await request(this.socketPath, "GET", "/v1/results", {}, undefined, this.requestTimeoutMs, 1 << 20);
		if (r.status === 404) return undefined;
		if (r.status !== 200) throw refusal(r.status, r.body);
		return JSON.parse(r.body.toString("utf8")) as AcceptedStage;
	}

	/**
	 * POST /v1/model/relay: one controlled model call. The frames are handed
	 * out as they arrive and collected; an error envelope (the sidecar's or
	 * the Proxy's) is a SidecarError. Aborting the signal closes the
	 * connection: the Proxy's send is not ours to stop, and the recorded
	 * outcome is what a later request of the same bytes reenters.
	 */
	relay(req: RelayRequest, options: RelayOptions = {}): Promise<RelayResult> {
		const body = Buffer.from(JSON.stringify(req));
		const deadlineMs = req.deadline
			? Math.max(1000, Date.parse(req.deadline) - Date.now() + 30_000)
			: this.requestTimeoutMs;
		return new Promise((resolve, reject) => {
			const frames: StreamFrame[] = [];
			let final: StreamFrame | undefined;
			let failed: Error | undefined;
			let expected = 0n;
			const parser = createParser({
				onEvent: (ev) => {
					if (failed) return;
					try {
						const f = parseFrame(ev.data, req.callId);
						const seq = BigInt(f.sequence);
						if (seq !== expected) throw new Error(`stream frame sequence ${f.sequence}, expected ${expected}`);
						expected = seq + 1n;
						if (final) throw new Error(`stream frame after the final frame`);
						frames.push(f);
						if (f.type === "done" || f.type === "error") final = f;
						options.onFrame?.(f);
					} catch (err) {
						failed = err as Error;
						httpReq.destroy(failed);
					}
				},
			});
			const httpReq = http.request(
				{
					socketPath: this.socketPath,
					method: "POST",
					path: "/v1/model/relay",
					headers: { "content-type": "application/json", "content-length": body.length, connection: "close" },
					agent: false,
					timeout: deadlineMs,
				},
				(res) => {
					const status = res.statusCode ?? 0;
					if (status !== 200) {
						const chunks: Buffer[] = [];
						res.on("data", (c: Buffer) => chunks.push(c));
						res.on("end", () => reject(refusal(status, Buffer.concat(chunks))));
						res.on("error", reject);
						return;
					}
					res.setEncoding("utf8");
					res.on("data", (chunk: string) => parser.feed(chunk));
					res.on("error", (err) => reject(failed ?? err));
					res.on("end", () => {
						if (failed) reject(failed);
						else resolve({ frames, final });
					});
				},
			);
			httpReq.on("timeout", () =>
				httpReq.destroy(new Error(`model relay ${req.callId}: no answer within ${deadlineMs} ms`)),
			);
			httpReq.on("error", (err) => reject(failed ?? err));
			if (options.signal) {
				if (options.signal.aborted) {
					httpReq.destroy(new Error("model relay aborted before the request"));
					return;
				}
				options.signal.addEventListener("abort", () => httpReq.destroy(new Error("model relay aborted")), {
					once: true,
				});
			}
			httpReq.end(body);
		});
	}
}
