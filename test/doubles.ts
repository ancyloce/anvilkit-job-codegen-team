// Controlled doubles of the team's dependencies. FakeSidecar stands in for
// the access sidecar (its trusted and candidate sockets) with a countable
// controlled relay: every physical send is counted per call identity, a
// repeat of the same bytes replays the record (no send), other bytes under
// the same identity conflict, and scripted behaviours cut, hang, refuse or
// end unknown. Nothing here is a provider, a Proxy or Control: it exercises
// the team's own mechanics; the integration scenarios use the real chain.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { encode } from "eventsource-encoder";
import type { AcceptedStage, RelayRequest, StreamFrame, Usage } from "../src/adapters/sidecar.js";

export interface ScriptedCall {
	/** Text frames, one per entry. */
	text?: string[];
	/** Tool calls (id, name, JSON arguments). */
	tools?: Array<{ id: string; name: string; arguments: string }>;
	usage?: Usage | false;
	/** end unknown (no usage), fail, cancel, refuse before any frame, cut the stream after n frames, hang until released. */
	behaviour?: "ok" | "unknown" | "failed" | "canceled" | "refuse" | "cut" | "hang" | "no-final";
	refuseCode?: string;
	refuseStatus?: number;
	cutAfter?: number;
}

export type Matcher = (req: RelayRequest) => ScriptedCall | undefined;

interface Record_ {
	digest: string;
	frames: StreamFrame[];
	sends: number;
	cutOnce: boolean;
	behaviour: ScriptedCall["behaviour"];
}

const defaultUsage: Usage = { inputUnits: "100", outputUnits: "50", reasoningUnits: "0", cachedInputUnits: "0" };

export function sha(data: string | Buffer): string {
	return `sha256:${createHash("sha256").update(data).digest("hex")}`;
}

export class FakeSidecar {
	readonly dir: string;
	readonly trustedSocket: string;
	readonly candidateSocket: string;
	readonly records = new Map<string, Record_>();
	readonly requests: RelayRequest[] = [];
	readonly transfers: Array<{
		class: string;
		mediaType: string;
		digest: string;
		size: number;
		handle: string;
		body: Buffer;
	}> = [];
	readonly results: Array<{
		verdict: string;
		failureCode: string;
		observer: string;
		manifest: Record<string, unknown>;
	}> = [];
	accepted: AcceptedStage | undefined;
	inFlight = 0;
	peakInFlight = 0;
	scope: Record<string, unknown> = {
		tenantId: "tenant_a",
		operationId: "op_team",
		attemptId: "att_team",
		instanceId: "inst_team",
		current: true,
		profileId: "harness-wiring-dev-v1",
		executionEpoch: "1",
		recoveryEpoch: "0",
		launchKey: "hp-team",
		deadline: new Date(Date.now() + 10 * 60_000).toISOString(),
	};
	inputs = new Map<string, Buffer>();
	private servers: http.Server[] = [];
	private released: Array<() => void> = [];
	private version = 0;
	/** Called for every relay request before it is served (default script: an empty text answer). */
	script: Matcher = () => ({ text: ["ok"] });
	/** Refuse everything on the trusted socket with this code (STALE_EXECUTION etc.) when set. */
	trustedRefusal: { status: number; code: string } | undefined;

	constructor(name = "fake-sidecar") {
		this.dir = path.join(tmpdir(), `${name}-${process.pid}-${Math.random().toString(16).slice(2, 8)}`);
		mkdirSync(this.dir, { recursive: true });
		this.trustedSocket = path.join(this.dir, "trusted.sock");
		this.candidateSocket = path.join(this.dir, "candidate.sock");
	}

	sends(callId: string): number {
		return this.records.get(callId)?.sends ?? 0;
	}

	totalSends(): number {
		let n = 0;
		for (const r of this.records.values()) n += r.sends;
		return n;
	}

	release(): void {
		for (const r of this.released) r();
		this.released = [];
	}

	async start(): Promise<void> {
		for (const [socket, kind] of [
			[this.trustedSocket, "trusted"],
			[this.candidateSocket, "candidate"],
		] as const) {
			if (existsSync(socket)) rmSync(socket);
			const srv = http.createServer((req, res) => this.handle(kind, req, res));
			srv.keepAliveTimeout = 0;
			await new Promise<void>((resolve) => srv.listen(socket, resolve));
			this.servers.push(srv);
		}
	}

	async stop(): Promise<void> {
		this.release();
		for (const s of this.servers) await new Promise<void>((resolve) => s.close(() => resolve()));
		this.servers = [];
		rmSync(this.dir, { recursive: true, force: true });
	}

	private json(res: http.ServerResponse, status: number, body: unknown): undefined {
		res.writeHead(status, { "content-type": "application/json", connection: "close" });
		res.end(JSON.stringify(body));
		return undefined;
	}

	private handle(kind: "trusted" | "candidate", req: http.IncomingMessage, res: http.ServerResponse): undefined {
		const chunks: Buffer[] = [];
		req.on("data", (c: Buffer) => chunks.push(c));
		req.on("end", () => {
			const body = Buffer.concat(chunks);
			const url = req.url ?? "/";
			if (kind === "candidate") {
				if (req.method === "GET" && url.startsWith("/v1/inputs/")) {
					const b = this.inputs.get(url.slice("/v1/inputs/".length));
					if (!b) return this.json(res, 404, { code: "NOT_FOUND" });
					res.writeHead(200, { "content-type": "application/octet-stream", connection: "close" });
					res.end(b);
					return undefined;
				}
				if (req.method === "POST" && url === "/v1/model/relay") return this.relay(res, body);
				return this.json(res, 403, { code: "ROUTE_FORBIDDEN" });
			}
			if (this.trustedRefusal) return this.json(res, this.trustedRefusal.status, { code: this.trustedRefusal.code });
			if (req.method === "GET" && url === "/v1/scope")
				return this.json(res, 200, { scope: this.scope, launchId: "launch_team", inputs: [...this.inputs.keys()] });
			if (req.method === "POST" && url === "/v1/model/relay") return this.relay(res, body);
			if (req.method === "POST" && url === "/v1/transfers") {
				const cls = String(req.headers["x-anvilkit-class"] ?? "");
				const mediaType = String(req.headers["content-type"] ?? "application/octet-stream");
				const digest = sha(body);
				const existing = this.transfers.find((t) => t.class === cls && t.digest === digest && t.size === body.length);
				if (existing)
					return this.json(res, 200, {
						handle: existing.handle,
						transferId: `t-${existing.handle}`,
						class: cls,
						digest,
						sizeBytes: String(body.length),
						objectVersion: `v-${existing.handle}`,
						state: "finalized",
						existing: true,
					});
				this.version += 1;
				const handle = `h-${cls}-${this.version}`;
				this.transfers.push({ class: cls, mediaType, digest, size: body.length, handle, body });
				return this.json(res, 200, {
					handle,
					transferId: `t-${handle}`,
					class: cls,
					digest,
					sizeBytes: String(body.length),
					objectVersion: `v-${handle}`,
					state: "finalized",
					existing: false,
				});
			}
			if (req.method === "POST" && url === "/v1/results") {
				const parsed = JSON.parse(body.toString("utf8")) as {
					verdict: string;
					failureCode: string;
					observerIdentity: string;
					manifest: Record<string, unknown>;
				};
				const manifestText = JSON.stringify(parsed.manifest);
				const digest = sha(manifestText);
				if (this.accepted) {
					if (this.accepted.resultDigest !== digest) return this.json(res, 409, { code: "IDEMPOTENCY_CONFLICT" });
					return this.json(res, 200, { stageId: this.accepted.stageId, resultDigest: digest, existing: true });
				}
				// Every output handle must be a finalized transfer of the same digest and size.
				const outputs =
					(parsed.manifest.outputs as Array<{ class: string; digest: string; sizeBytes: string; handle?: string }>) ??
					[];
				const artifacts = [];
				for (const o of outputs) {
					const t = this.transfers.find((x) => x.handle === o.handle);
					if (!t || t.digest !== o.digest || String(t.size) !== o.sizeBytes || t.class !== o.class)
						return this.json(res, 400, {
							code: "INVALID_ARGUMENT",
							reason: `output ${o.class} names no finalized transfer of its digest`,
						});
					artifacts.push({
						handle: t.handle,
						class: t.class,
						digest: t.digest,
						sizeBytes: String(t.size),
						transferId: `t-${t.handle}`,
						objectVersion: `v-${t.handle}`,
					});
				}
				this.results.push({
					verdict: parsed.verdict,
					failureCode: parsed.failureCode,
					observer: parsed.observerIdentity,
					manifest: parsed.manifest,
				});
				this.accepted = {
					stageId: "stage-1",
					attemptId: String(this.scope.attemptId),
					instanceId: String(this.scope.instanceId),
					verdict: parsed.verdict,
					...(parsed.failureCode ? { failureCode: parsed.failureCode } : {}),
					resultDigest: digest,
					observerIdentity: parsed.observerIdentity,
					profileId: String(this.scope.profileId),
					executionEpoch: String(this.scope.executionEpoch),
					recoveryEpoch: String(this.scope.recoveryEpoch),
					artifacts,
				};
				return this.json(res, 200, { stageId: "stage-1", resultDigest: digest, existing: false });
			}
			if (req.method === "GET" && url === "/v1/results") {
				if (!this.accepted) return this.json(res, 404, { code: "NOT_FOUND" });
				return this.json(res, 200, this.accepted);
			}
			return this.json(res, 403, { code: "ROUTE_FORBIDDEN" });
		});
	}

	private frames(callId: string, s: ScriptedCall): StreamFrame[] {
		const out: StreamFrame[] = [];
		let seq = 0;
		const next = (f: Omit<StreamFrame, "callId" | "sequence">) => out.push({ callId, sequence: String(seq++), ...f });
		next({ type: "admitted" });
		for (const t of s.text ?? []) next({ type: "text", text: t });
		for (const tc of s.tools ?? [])
			next({
				type: "tool_call",
				toolCall: { toolCallId: tc.id, name: tc.name, argumentsDigest: sha(tc.arguments), arguments: tc.arguments },
			});
		const b = s.behaviour ?? "ok";
		if (b === "ok" || b === "cut" || b === "hang") {
			if (s.usage !== false) next({ type: "usage", usage: s.usage ?? defaultUsage });
			next({ type: "done", outcome: "succeeded" });
		} else if (b === "unknown") next({ type: "error", outcome: "unknown", errorCode: "USAGE_MISSING" });
		else if (b === "failed") next({ type: "error", outcome: "failed", errorCode: "UPSTREAM_FAILED" });
		else if (b === "canceled") next({ type: "error", outcome: "canceled", errorCode: "CANCELED" });
		return out;
	}

	private relay(res: http.ServerResponse, body: Buffer): undefined {
		let parsed: RelayRequest;
		try {
			parsed = JSON.parse(body.toString("utf8")) as RelayRequest;
		} catch {
			return this.json(res, 400, { code: "INVALID_ARGUMENT" });
		}
		this.requests.push(parsed);
		const digest = sha(body.toString("utf8"));
		let record = this.records.get(parsed.callId);
		if (record && record.digest !== digest)
			return this.json(res, 409, {
				error: {
					code: "IDEMPOTENCY_CONFLICT",
					message: "another request under this call id",
					requestId: "r",
					retryable: false,
				},
			});
		let replay = false;
		if (!record) {
			const scripted = this.script(parsed) ?? { text: ["ok"] };
			if (scripted.behaviour === "refuse")
				return this.json(res, scripted.refuseStatus ?? 403, {
					error: {
						code: scripted.refuseCode ?? "BUDGET_EXHAUSTED",
						message: "scripted refusal",
						requestId: "r",
						retryable: false,
					},
				});
			record = {
				digest,
				frames: this.frames(parsed.callId, scripted),
				sends: 1,
				cutOnce: scripted.behaviour === "cut",
				behaviour: scripted.behaviour ?? "ok",
			};
			if (scripted.behaviour === "cut") record.frames = record.frames.map((f) => f); // the record is complete; the first answer is cut
			(record as Record_ & { cutAfter?: number }).cutAfter = scripted.cutAfter ?? 1;
			this.records.set(parsed.callId, record);
		} else {
			replay = true;
		}
		this.inFlight++;
		this.peakInFlight = Math.max(this.peakInFlight, this.inFlight);
		res.writeHead(200, { "content-type": "text/event-stream", connection: "close" });
		const write = (f: StreamFrame) => res.write(encode({ id: f.sequence, data: JSON.stringify(f) }));
		const finish = () => {
			this.inFlight--;
			res.end();
		};
		if (record.behaviour === "hang" && !replay) {
			write(record.frames[0] as StreamFrame);
			this.released.push(() => {
				for (const f of record.frames.slice(1)) write(f);
				finish();
			});
			return;
		}
		if (record.behaviour === "no-final") {
			for (const f of record.frames.filter((x) => x.type !== "done" && x.type !== "error")) write(f);
			finish();
			return;
		}
		if (record.cutOnce && !replay) {
			record.cutOnce = false;
			const n = (record as Record_ & { cutAfter?: number }).cutAfter ?? 1;
			for (const f of record.frames.slice(0, n)) write(f);
			this.inFlight--;
			res.destroy();
			return;
		}
		for (const f of record.frames) write(f);
		finish();
	}
}
