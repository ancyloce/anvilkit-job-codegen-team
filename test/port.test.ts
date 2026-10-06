import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type RelayMessage, SidecarClient } from "../src/adapters/sidecar.js";
import type { Allowance } from "../src/budget.js";
import {
	BudgetExhaustedError,
	ControlledModelPort,
	DeadlineExceededError,
	EffectUncertainError,
	ModelCallFailedError,
	ModelCallRefusedError,
} from "../src/port/model.js";
import { FakeSidecar } from "./doubles.js";

const remaining = (): Allowance => ({
	calls: 3,
	exposure: { currency: "USD", amount: "60000" },
	aggregateCalls: 10,
	aggregateExposure: { currency: "USD", amount: "100000" },
});
const messages: RelayMessage[] = [
	{ role: "system", content: "You are the planner." },
	{ role: "user", content: "Plan." },
];

describe("ControlledModelPort", () => {
	let sidecar: FakeSidecar;
	let port: ControlledModelPort;
	beforeEach(async () => {
		sidecar = new FakeSidecar("port");
		await sidecar.start();
		const client = new SidecarClient(sidecar.trustedSocket);
		port = new ControlledModelPort({
			relay: (req, o) => client.relay(req, o),
			routeId: "controlled-openai-v1",
			deadline: new Date(Date.now() + 60_000),
			callIdPrefix: "att_team",
			maxConcurrent: 2,
		});
	});
	afterEach(async () => {
		await sidecar.stop();
	});

	const input = (ordinal = 1, over: Partial<Parameters<ControlledModelPort["call"]>[0]> = {}) => ({
		role: "planner" as const,
		ordinal,
		messages,
		maxOutputTokens: 256,
		exposure: { currency: "USD", amount: "20000" },
		remaining: remaining(),
		...over,
	});

	it("one call is one physical send; the same call again replays the record without a send", async () => {
		sidecar.script = () => ({
			text: ["Hello", " team"],
			tools: [{ id: "tc_1", name: "submit_plan", arguments: '{"steps":[]}' }],
		});
		const first = await port.call(input());
		expect(first.callId).toBe("att_team:planner:1");
		expect(first.text).toBe("Hello team");
		expect(first.toolCalls).toEqual([{ toolCallId: "tc_1", name: "submit_plan", arguments: '{"steps":[]}' }]);
		expect(first.usage?.inputUnits).toBe("100");
		expect(first.reentered).toBe(false);
		expect(sidecar.sends("att_team:planner:1")).toBe(1);
		const again = await port.call(input());
		expect(again.text).toBe("Hello team");
		expect(sidecar.sends("att_team:planner:1")).toBe(1);
		expect(sidecar.requests).toHaveLength(2);
		expect(port.ledger.map((l) => l.outcome)).toEqual(["succeeded", "succeeded"]);
		// Two observations of one identity are one call of the allowance; a second identity is a second call.
		expect(port.spent("planner")).toEqual({ calls: 1, exposure: 20000n });
		await port.call(input(2));
		expect(sidecar.totalSends()).toBe(2);
		expect(port.spent("planner")).toEqual({ calls: 2, exposure: 40000n });
	});

	it("a cut stream is reentered under the same identity: one physical send, the record replayed", async () => {
		sidecar.script = () => ({ text: ["A", "B", "C"], behaviour: "cut", cutAfter: 2 });
		const r = await port.call(input(2));
		expect(r.text).toBe("ABC");
		expect(r.reentered).toBe(true);
		expect(sidecar.sends("att_team:planner:2")).toBe(1);
		expect(sidecar.requests.filter((q) => q.callId === "att_team:planner:2")).toHaveLength(2);
		// One call, one ledger entry, one charge: the reentry is the same call.
		expect(port.ledger.filter((l) => l.callId === "att_team:planner:2")).toHaveLength(1);
		expect(port.spent("planner")).toEqual({ calls: 1, exposure: 20000n });
	});

	it("a stream without a final frame is an uncertain effect, never a resend", async () => {
		sidecar.script = () => ({ text: ["A"], behaviour: "no-final" });
		await expect(port.call(input(3))).rejects.toBeInstanceOf(EffectUncertainError);
		expect(sidecar.sends("att_team:planner:3")).toBe(1);
		expect(port.ledger.at(-1)?.outcome).toBe("unknown");
	});

	it("an unknown outcome stops the caller and fences every other identity until it is reconciled; failed and canceled are definite", async () => {
		sidecar.script = (req) => ({
			behaviour: req.callId.endsWith(":4") ? "unknown" : req.callId.endsWith(":5") ? "failed" : "canceled",
		});
		await expect(port.call(input(4))).rejects.toBeInstanceOf(EffectUncertainError);
		expect(port.unreconciled()).toBe("att_team:planner:4");
		// No new identity is admitted — not the next ordinal, not another role — and nothing is sent for it.
		await expect(port.call(input(5))).rejects.toMatchObject({ code: "EFFECT_UNCERTAIN", callId: "att_team:planner:4" });
		await expect(port.call(input(1, { role: "code_reviewer" }))).rejects.toBeInstanceOf(EffectUncertainError);
		expect(sidecar.sends("att_team:planner:5")).toBe(0);
		expect(sidecar.requests.filter((q) => q.callId !== "att_team:planner:4")).toHaveLength(0);
		// The original identity may be asked again (the reconciliation path): the record is replayed, still unknown, no send.
		await expect(port.call(input(4))).rejects.toBeInstanceOf(EffectUncertainError);
		expect(sidecar.sends("att_team:planner:4")).toBe(1);
		expect(sidecar.totalSends()).toBe(1);
		expect(port.ledger.map((l) => l.outcome)).toEqual(["unknown", "unknown"]);
		// The reconciliation of the original identity is not a second charge.
		expect(port.spent("planner")).toEqual({ calls: 1, exposure: 20000n });
		// Definite outcomes on a port with nothing unreconciled.
		const other = new ControlledModelPort({
			relay: (req, o) => new SidecarClient(sidecar.trustedSocket).relay(req, o),
			routeId: "controlled-openai-v1",
			deadline: new Date(Date.now() + 60_000),
			callIdPrefix: "att_team",
			maxConcurrent: 2,
		});
		await expect(other.call(input(5))).rejects.toMatchObject({ outcome: "failed", code: "UPSTREAM_FAILED" });
		await expect(other.call(input(6))).rejects.toBeInstanceOf(ModelCallFailedError);
		expect(other.unreconciled()).toBeUndefined();
		expect(sidecar.totalSends()).toBe(3);
	});

	it("a refusal before any frame is reported with its code and nothing is sent", async () => {
		sidecar.script = () => ({ behaviour: "refuse", refuseCode: "BUDGET_EXHAUSTED", refuseStatus: 429 });
		await expect(port.call(input(7))).rejects.toBeInstanceOf(ModelCallRefusedError);
		expect(sidecar.sends("att_team:planner:7")).toBe(0);
		expect(port.ledger.at(-1)).toMatchObject({ outcome: "refused", code: "BUDGET_EXHAUSTED" });
		// An admitted call counts against the allowance whatever the relay answered.
		expect(port.spent("planner")).toEqual({ calls: 1, exposure: 20000n });
	});

	it("the allowance is checked before a send: calls, role exposure, aggregate exposure, currency, deadline", async () => {
		await expect(port.call(input(8, { remaining: { ...remaining(), calls: 0 } }))).rejects.toBeInstanceOf(
			BudgetExhaustedError,
		);
		await expect(
			port.call(input(8, { remaining: { ...remaining(), exposure: { currency: "USD", amount: "100" } } })),
		).rejects.toBeInstanceOf(BudgetExhaustedError);
		await expect(
			port.call(input(8, { remaining: { ...remaining(), aggregateExposure: { currency: "USD", amount: "100" } } })),
		).rejects.toBeInstanceOf(BudgetExhaustedError);
		await expect(port.call(input(8, { exposure: { currency: "EUR", amount: "1" } }))).rejects.toBeInstanceOf(
			BudgetExhaustedError,
		);
		expect(sidecar.requests).toHaveLength(0);
		// A call refused before admission spends nothing.
		expect(port.spent("planner")).toEqual({ calls: 0, exposure: 0n });
		const late = new ControlledModelPort({
			relay: () => Promise.reject(new Error("unreachable")),
			routeId: "r",
			deadline: new Date(Date.now() - 1),
			callIdPrefix: "x",
			maxConcurrent: 1,
		});
		await expect(late.call(input(1))).rejects.toBeInstanceOf(DeadlineExceededError);
	});

	it("abandoning a call closes the connection and records an uncertain outcome; the record is what a repeat reenters", async () => {
		sidecar.script = () => ({ text: ["slow"], behaviour: "hang" });
		const ac = new AbortController();
		const pending = port.call(input(9), { signal: ac.signal });
		await new Promise((r) => setTimeout(r, 150));
		ac.abort();
		await expect(pending).rejects.toBeInstanceOf(EffectUncertainError);
		expect(sidecar.sends("att_team:planner:9")).toBe(1);
		sidecar.release();
		const again = await port.call(input(9));
		expect(again.text).toBe("slow");
		expect(sidecar.sends("att_team:planner:9")).toBe(1);
		// The unknown observation and its reconciliation are one call of the allowance.
		expect(port.ledger.filter((l) => l.callId === "att_team:planner:9").map((l) => l.outcome)).toEqual([
			"unknown",
			"succeeded",
		]);
		expect(port.spent("planner")).toEqual({ calls: 1, exposure: 20000n });
	});

	it("a call queued for a slot is fenced again before its send: an identity that became unknown meanwhile refuses it, and the original identity reenters without a send", async () => {
		sidecar.script = () => ({ text: ["slow"], behaviour: "hang" });
		const one = new ControlledModelPort({
			relay: (req, o) => new SidecarClient(sidecar.trustedSocket).relay(req, o),
			routeId: "controlled-openai-v1",
			deadline: new Date(Date.now() + 60_000),
			callIdPrefix: "att_team",
			maxConcurrent: 1,
		});
		const ac = new AbortController();
		const first = one.call(input(1), { signal: ac.signal });
		await new Promise((r) => setTimeout(r, 100));
		// The second identity passed the pre-queue checks while nothing was unreconciled and waits for the slot.
		const second = one.call(input(2));
		await new Promise((r) => setTimeout(r, 100));
		ac.abort();
		await expect(first).rejects.toBeInstanceOf(EffectUncertainError);
		expect(one.unreconciled()).toBe("att_team:planner:1");
		// The slot the first call held goes to the second, which is refused before its send: zero receives upstream.
		await expect(second).rejects.toMatchObject({ code: "EFFECT_UNCERTAIN", callId: "att_team:planner:1" });
		expect(sidecar.sends("att_team:planner:2")).toBe(0);
		expect(sidecar.requests.filter((q) => q.callId === "att_team:planner:2")).toHaveLength(0);
		expect(one.ledger.map((l) => l.callId)).toEqual(["att_team:planner:1"]);
		// The refusal released the slot: the original identity reenters its record (no send) and completes.
		sidecar.release();
		const again = await one.call(input(1));
		expect(again.text).toBe("slow");
		expect(sidecar.sends("att_team:planner:1")).toBe(1);
		expect(sidecar.totalSends()).toBe(1);
		expect(one.unreconciled()).toBeUndefined();
	});

	it("a call whose signal aborts or whose deadline passes while it waits for a slot sends nothing and leaks no slot", async () => {
		sidecar.script = () => ({ text: ["slow"], behaviour: "hang" });
		let clock = Date.now();
		const one = new ControlledModelPort({
			relay: (req, o) => new SidecarClient(sidecar.trustedSocket).relay(req, o),
			routeId: "controlled-openai-v1",
			deadline: new Date(clock + 10_000),
			callIdPrefix: "att_team",
			maxConcurrent: 1,
			now: () => new Date(clock),
		});
		// Canceled while waiting.
		const first = one.call(input(1));
		await new Promise((r) => setTimeout(r, 100));
		const ac = new AbortController();
		const canceled = one.call(input(2), { signal: ac.signal });
		await new Promise((r) => setTimeout(r, 100));
		ac.abort();
		sidecar.release();
		expect((await first).text).toBe("slow");
		await expect(canceled).rejects.toMatchObject({ outcome: "canceled", code: "CANCELED" });
		expect(sidecar.sends("att_team:planner:2")).toBe(0);
		// The deadline passes while waiting.
		const third = one.call(input(3));
		await new Promise((r) => setTimeout(r, 100));
		const late = one.call(input(4));
		await new Promise((r) => setTimeout(r, 100));
		clock += 20_000;
		sidecar.release();
		expect((await third).text).toBe("slow");
		await expect(late).rejects.toBeInstanceOf(DeadlineExceededError);
		expect(sidecar.sends("att_team:planner:4")).toBe(0);
		expect(sidecar.requests.map((q) => q.callId)).toEqual(["att_team:planner:1", "att_team:planner:3"]);
		// Nothing was asked of the relay for them: no ledger line, no charge.
		expect(one.ledger.map((l) => l.callId)).toEqual(["att_team:planner:1", "att_team:planner:3"]);
		expect(one.spent("planner")).toEqual({ calls: 2, exposure: 40000n });
		// Both refusals released their slot: a call within the deadline goes through.
		clock -= 20_000;
		sidecar.script = () => ({ text: ["next"] });
		expect((await one.call(input(5))).text).toBe("next");
		expect(one.peakConcurrency).toBe(1);
	});

	it("at most maxConcurrent calls are in flight", async () => {
		sidecar.script = () => ({ text: ["x"], behaviour: "hang" });
		const calls = [10, 11, 12, 13].map((n) => port.call(input(n)));
		await new Promise((r) => setTimeout(r, 200));
		expect(sidecar.inFlight).toBe(2);
		sidecar.release();
		await new Promise((r) => setTimeout(r, 200));
		sidecar.release();
		await Promise.all(calls);
		expect(sidecar.peakInFlight).toBe(2);
		expect(port.peakConcurrency).toBe(2);
	});
});
