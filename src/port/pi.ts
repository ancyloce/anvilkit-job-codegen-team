// The Pi side of the ControlledModelPort (DD-03 §2/§6): a pi-agent-core
// StreamFn whose only transport is the port. Pi's Context (system prompt,
// history, tools) is mapped to the relay contract's messages and reviewed
// tool definitions; the Proxy's frames come back as pi-ai assistant message
// events. Pi's custom event protocol is not an OpenAI-compatible base URL:
// nothing here builds a provider client, and the model object handed to Pi
// carries no base URL, key or provider identity a vendor SDK could use.
import type { StreamFn } from "@earendil-works/pi-agent-core";
import {
	type AssistantMessage,
	type AssistantMessageEvent,
	type AssistantMessageEventStream,
	type Context,
	createAssistantMessageEventStream,
	type Message,
	type Model,
	type Usage as PiUsage,
	type StopReason,
	type Tool,
	type ToolCall,
} from "@earendil-works/pi-ai";
import type { Money, RelayMessage, RelayToolDefinition, Usage } from "../adapters/sidecar.js";
import type { Allowance } from "../budget.js";
import { canonicalDigest } from "../digest.js";
import {
	BudgetExhaustedError,
	type ControlledModelPort,
	DeadlineExceededError,
	EffectUncertainError,
	ModelCallFailedError,
	ModelCallRefusedError,
	type ModelCallResult,
	type Role,
} from "./model.js";

/** The route as Pi sees it: an identity for the session transcript, no transport facts. */
export const proxyProvider = "anvilkit-model-proxy";

/**
 * The api of the controlled route is the team's own, not one of pi-ai's
 * provider APIs: a Model whose api is "openai-completions" would let the
 * SDK's own streamSimple build a vendor client and reach the vendor's
 * default endpoint with whatever the credential field holds (observed:
 * a 401 from the public OpenAI API on a host with network). Under this api
 * pi-ai finds no adapter of its own; only the registered provider's
 * refusing handler and the port exist.
 */
export const controlledApi = "anvilkit-controlled-relay";

export type ControlledModel = Model<typeof controlledApi>;

export function controlledModel(routeId: string, contextWindow: number, maxTokens: number): ControlledModel {
	return {
		id: routeId,
		name: routeId,
		api: controlledApi,
		provider: proxyProvider,
		baseUrl: `relay://${proxyProvider}`,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow,
		maxTokens,
	};
}

const zeroUsage = (): PiUsage => ({
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

export function usageToPi(u: Usage | undefined): PiUsage {
	if (!u) return zeroUsage();
	const n = (s: string) => Number.parseInt(s, 10);
	const input = n(u.inputUnits);
	const output = n(u.outputUnits);
	return {
		input,
		output,
		cacheRead: n(u.cachedInputUnits),
		cacheWrite: 0,
		reasoning: n(u.reasoningUnits),
		totalTokens: input + output,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function textOf(content: Message["content"], what: string): string {
	if (typeof content === "string") return content;
	let out = "";
	for (const block of content) {
		if (block.type === "text") out += block.text;
		else if (block.type === "image") throw new Error(`${what}: images are not relayed`);
		// thinking blocks are the provider's private stream; they never leave the session
	}
	return out;
}

/** Pi's context as the relay contract's messages. */
export function contextToRelay(context: Context): RelayMessage[] {
	const out: RelayMessage[] = [];
	if (context.systemPrompt) out.push({ role: "system", content: context.systemPrompt });
	context.messages.forEach((m, i) => {
		const at = `message ${i}`;
		if (m.role === "user") {
			out.push({ role: "user", content: textOf(m.content, at) });
		} else if (m.role === "assistant") {
			const msg: RelayMessage = { role: "assistant", content: textOf(m.content, at) };
			const calls = m.content.filter((c): c is ToolCall => c.type === "toolCall");
			if (calls.length > 0)
				msg.toolCalls = calls.map((c) => ({ toolCallId: c.id, name: c.name, arguments: JSON.stringify(c.arguments) }));
			out.push(msg);
		} else if (m.role === "toolResult") {
			out.push({ role: "tool", content: textOf(m.content, at), toolCallId: m.toolCallId });
		} else {
			throw new Error(`${at}: role ${(m as { role: string }).role} is not relayed`);
		}
	});
	return out;
}

/** Pi's tools as reviewed tool definitions: the name and the canonical digest of the exact parameter schema. */
export function toolsToRelay(tools: Tool[] | undefined): RelayToolDefinition[] | undefined {
	if (!tools || tools.length === 0) return undefined;
	return tools.map((t) => {
		const def: RelayToolDefinition = { name: t.name, inputSchemaDigest: canonicalDigest(t.parameters) };
		if (t.description) def.description = t.description.length > 4096 ? t.description.slice(0, 4096) : t.description;
		return def;
	});
}

export interface ControlledStreamFnOptions {
	port: ControlledModelPort;
	role: Role;
	maxOutputTokens: number;
	exposure: Money;
	/** The allowance left before each call; the caller updates it from the results it is told about. */
	remaining: () => Allowance;
	/** The ordinal of the next call (deterministic across restarts of the same round). */
	nextOrdinal: () => number;
	onResult?: (result: ModelCallResult) => void;
	onFailure?: (err: Error) => void;
}

/** A pi-agent-core StreamFn over the port: one relay call per invocation, frames as events, no retry. */
export function createControlledStreamFn(o: ControlledStreamFnOptions): StreamFn {
	return (model, context, options) => {
		const stream = createAssistantMessageEventStream();
		void run(o, model, context, options?.signal, stream);
		return stream;
	};
}

function baseMessage(model: Model<string>, stopReason: StopReason): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: zeroUsage(),
		stopReason,
		timestamp: Date.now(),
	};
}

async function run(
	o: ControlledStreamFnOptions,
	model: Model<string>,
	context: Context,
	signal: AbortSignal | undefined,
	stream: AssistantMessageEventStream,
): Promise<void> {
	const partial = baseMessage(model, "pending");
	const push = (ev: AssistantMessageEvent) => stream.push(ev);
	const fail = (reason: "error" | "aborted", message: string) => {
		const error = { ...partial, stopReason: reason, errorMessage: message, timestamp: Date.now() };
		push({ type: "error", reason, error });
		stream.end(error);
	};
	let messages: RelayMessage[];
	try {
		messages = contextToRelay(context);
	} catch (err) {
		fail("error", (err as Error).message);
		return;
	}
	// An unreconciled call of this port fences every later send: nothing
	// takes a new ordinal, and the turn ends with the original identity named.
	const pending = o.port.unreconciled();
	if (pending !== undefined) {
		const err = new EffectUncertainError(
			pending,
			`${o.role}: no further call while the outcome of ${pending} is not established`,
		);
		o.onFailure?.(err);
		fail("error", `${err.code}: ${err.message}`);
		return;
	}
	let started = false;
	let textOpen = false;
	const contentOf = () => partial.content;
	try {
		const result = await o.port.call(
			{
				role: o.role,
				ordinal: o.nextOrdinal(),
				messages,
				tools: toolsToRelay(context.tools),
				maxOutputTokens: Math.min(o.maxOutputTokens, model.maxTokens),
				exposure: o.exposure,
				remaining: o.remaining(),
			},
			{ signal },
		);
		// The Proxy's frames arrived in order; they are replayed to Pi as the
		// event protocol requires (start, then blocks, then done).
		push({ type: "start", partial });
		started = true;
		for (const f of result.streamed) {
			if (f.type === "text" && f.text !== undefined) {
				if (!textOpen) {
					contentOf().push({ type: "text", text: "" });
					push({ type: "text_start", contentIndex: contentOf().length - 1, partial });
					textOpen = true;
				}
				const idx = contentOf().length - 1;
				const block = contentOf()[idx];
				if (block && block.type === "text") block.text += f.text;
				push({ type: "text_delta", contentIndex: idx, delta: f.text, partial });
			} else if (f.type === "tool_call" && f.toolCall) {
				if (textOpen) {
					const idx = contentOf().length - 1;
					const block = contentOf()[idx];
					push({
						type: "text_end",
						contentIndex: idx,
						content: block && block.type === "text" ? block.text : "",
						partial,
					});
					textOpen = false;
				}
				let args: Record<string, unknown>;
				try {
					const parsed: unknown = JSON.parse(f.toolCall.arguments ?? "");
					if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
					args = parsed as Record<string, unknown>;
				} catch {
					fail("error", `tool call ${f.toolCall.toolCallId}: arguments are not a JSON object`);
					return;
				}
				const call: ToolCall = { type: "toolCall", id: f.toolCall.toolCallId, name: f.toolCall.name, arguments: args };
				contentOf().push(call);
				const idx = contentOf().length - 1;
				push({ type: "toolcall_start", contentIndex: idx, partial });
				push({ type: "toolcall_delta", contentIndex: idx, delta: f.toolCall.arguments ?? "", partial });
				push({ type: "toolcall_end", contentIndex: idx, toolCall: call, partial });
			}
		}
		if (textOpen) {
			const idx = contentOf().length - 1;
			const block = contentOf()[idx];
			push({ type: "text_end", contentIndex: idx, content: block && block.type === "text" ? block.text : "", partial });
		}
		const reason: "stop" | "toolUse" = result.toolCalls.length > 0 ? "toolUse" : "stop";
		const message: AssistantMessage = {
			...partial,
			usage: usageToPi(result.usage),
			stopReason: reason,
			responseId: result.callId,
			timestamp: Date.now(),
		};
		o.onResult?.(result);
		push({ type: "done", reason, message });
		stream.end(message);
	} catch (err) {
		o.onFailure?.(err as Error);
		if (!started) {
			// No event was emitted yet: the protocol allows a direct error.
		}
		const e = err as Error;
		if (e instanceof ModelCallFailedError && e.outcome === "canceled") fail("aborted", e.message);
		else if (
			e instanceof BudgetExhaustedError ||
			e instanceof DeadlineExceededError ||
			e instanceof ModelCallRefusedError ||
			e instanceof EffectUncertainError ||
			e instanceof ModelCallFailedError
		)
			fail("error", `${(e as { code?: string }).code ?? e.name}: ${e.message}`);
		else fail("error", e.message);
	}
}
