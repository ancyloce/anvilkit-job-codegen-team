import { describe, expect, it } from "vitest";
import type { ControlledModelPort, ModelCallResult } from "../src/port/model.js";
import { type Plan, runSpecialist, type SpecialistCall, SpecialistOutputError, tool } from "../src/team/roles.js";

// plan 0007 P1.4: each rejected specialist answer is recorded with its check
// and a trusted message, never with the model's text.
const modelText = "model-text-c41e";

function answer(callId: string, args: string): ModelCallResult {
	return {
		callId,
		role: "planner",
		text: "",
		toolCalls: [{ toolCallId: `tc_${callId}`, name: "submit_plan", arguments: args }],
		exposure: { currency: "USD", amount: "1" },
		frames: 1,
		reentered: false,
		streamed: [],
	};
}

function planner(answers: ModelCallResult[], calls: number) {
	const sent: ModelCallResult[] = [];
	const port = {
		call: async () => {
			const next = answers.shift();
			if (!next) throw new Error("no scripted answer");
			sent.push(next);
			return next;
		},
	} as unknown as ControlledModelPort;
	const rejected: Parameters<NonNullable<SpecialistCall<Plan>["onRejected"]>>[0][] = [];
	let ordinal = 0;
	const call: SpecialistCall<Plan> = {
		role: "planner",
		systemPrompt: "",
		user: "",
		tool: tool("submit_plan"),
		maxOutputTokens: 100,
		exposure: { currency: "USD", amount: "1" },
		remaining: () => ({
			calls: calls - sent.length,
			exposure: { currency: "USD", amount: "10" },
			aggregateCalls: 10,
			aggregateExposure: { currency: "USD", amount: "10" },
		}),
		nextOrdinal: () => ++ordinal,
		onResult: () => {},
		accept: (args) => {
			const p = args as unknown as Plan;
			return p.componentId === "cmp_hero_fixed"
				? { ok: true, value: p }
				: {
						ok: false,
						reason: `componentId ${p.componentId} is not the brief's`,
						rule: "the plan's componentId is not the brief's",
					};
		},
		onRejected: (r) => rejected.push(r),
	};
	return { port, call, rejected };
}

const plan = (componentId: string) =>
	JSON.stringify({
		componentId,
		puckType: "Hero",
		packageName: "@anvilkit/hero-fixed",
		version: "1.0.0",
		steps: [{ id: "all", title: "Everything", files: ["component.json"], detail: "All files." }],
	});

describe("runSpecialist keeps why an answer was rejected (plan 0007 P1.4)", () => {
	it("records an acceptor's fixed rule, not the values the model wrote", async () => {
		const { port, call, rejected } = planner(
			[answer("c1", plan(`cmp_${modelText}`)), answer("c2", plan("cmp_hero_fixed"))],
			2,
		);
		const out = await runSpecialist(port, call);
		expect(out.calls).toBe(2);
		expect(rejected).toEqual([
			{ role: "planner", callId: "c1", check: "accept", detail: "the plan's componentId is not the brief's" },
		]);
		expect(JSON.stringify(rejected)).not.toContain(modelText);
	});

	it("names the last rejection's check when the budget runs out, without the parser's text", async () => {
		const { port, call, rejected } = planner(
			[answer("c1", `{"steps": "${modelText}"`), answer("c2", `{"componentId": "${modelText}",`)],
			2,
		);
		const err = await runSpecialist(port, call).then(
			() => undefined,
			(e: unknown) => e,
		);
		expect(err).toBeInstanceOf(SpecialistOutputError);
		expect((err as Error).message).toBe(
			"planner: no schema-valid submit_plan within the role's call budget, the last: the rejected answer of call c2 (strict_json: the submit_plan arguments are not one strict JSON object)",
		);
		expect(rejected.map((r) => r.check)).toEqual(["strict_json", "strict_json"]);
		expect(`${(err as Error).message} ${JSON.stringify(rejected)}`).not.toContain(modelText);
	});
});
