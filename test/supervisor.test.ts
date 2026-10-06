// The supervisor adapter over in-memory streams: one request outstanding,
// answers matched by requestId and round, final refusals marked, and any
// answer outside the protocol breaking the channel for every round.
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { SupervisorRunner } from "../src/adapters/supervisor.js";
import { CandidateRoundRefusedError } from "../src/executor.js";

function channel() {
	const toSupervisor = new PassThrough();
	const fromSupervisor = new PassThrough();
	const requests: Array<Record<string, unknown>> = [];
	toSupervisor.on("data", (c: Buffer) => {
		for (const line of c.toString().split("\n").filter(Boolean)) requests.push(JSON.parse(line));
	});
	const runner = new SupervisorRunner(toSupervisor, fromSupervisor);
	const answer = (a: Record<string, unknown> | string) =>
		fromSupervisor.write(`${typeof a === "string" ? a : JSON.stringify(a)}\n`);
	return { runner, requests, answer, close: () => fromSupervisor.end() };
}

const ended = (requestId: number, round: number) => ({
	type: "candidate-ended",
	protocolVersion: 1,
	requestId,
	round,
	stop: "exited",
	exit: 0,
	descendantsStopped: 0,
	startedAt: "2026-10-06T10:00:00Z",
	endedAt: "2026-10-06T10:00:01Z",
});

const tick = () => new Promise((r) => setTimeout(r, 10));

describe("SupervisorRunner", () => {
	it("asks one round at a time with increasing request ids and resolves the supervisor's account", async () => {
		const { runner, requests, answer } = channel();
		const first = runner.run({ round: 1, roundDir: "/workspace/round/1" });
		await tick();
		expect(requests).toEqual([
			{ type: "run-candidate", protocolVersion: 1, requestId: 1, round: 1, roundDir: "/workspace/round/1" },
		]);
		await expect(runner.run({ round: 2, roundDir: "/workspace/round/2" })).rejects.toThrow(/one round runs at a time/);
		answer({ ...ended(1, 1), stop: "timeout", exit: null, signal: "killed", descendantsStopped: 2 });
		await expect(first).resolves.toMatchObject({
			stop: "timeout",
			exit: null,
			signal: "killed",
			descendantsStopped: 2,
		});
		const second = runner.run({ round: 2, roundDir: "/workspace/round/2" });
		await tick();
		expect(requests[1]).toMatchObject({ requestId: 2, round: 2 });
		answer(ended(2, 2));
		await expect(second).resolves.toMatchObject({ stop: "exited", exit: 0 });
	});

	it("a final refusal is marked final; a request-level refusal is not", async () => {
		const { runner, answer } = channel();
		const r1 = runner.run({ round: 1, roundDir: "/workspace/round/1" });
		await tick();
		answer({ type: "refused", protocolVersion: 1, requestId: 1, round: 1, code: "ROUND_DIR_INVALID", reason: "x" });
		const e1 = await r1.catch((e) => e);
		expect(e1).toBeInstanceOf(CandidateRoundRefusedError);
		expect(e1).toMatchObject({ code: "ROUND_DIR_INVALID", final: false });
		const r2 = runner.run({ round: 2, roundDir: "/workspace/round/2" });
		await tick();
		answer({ type: "refused", protocolVersion: 1, requestId: 2, round: 2, code: "STOP_NOT_ESTABLISHED", reason: "y" });
		await expect(r2).rejects.toMatchObject({ code: "STOP_NOT_ESTABLISHED", final: true });
	});

	it("an answer outside the protocol, for another request or round, or unasked breaks the channel for every round", async () => {
		for (const bad of [
			ended(2, 1), // another request
			ended(1, 2), // another round
			'{"type":"candidate-ended","type":"refused"}', // duplicate member
			"not json",
			{ ...ended(1, 1), exit: null }, // a null exit without its signal
		]) {
			const { runner, answer } = channel();
			const pending = runner.run({ round: 1, roundDir: "/workspace/round/1" });
			await tick();
			answer(bad);
			await expect(pending).rejects.toThrow(/process protocol/);
			await expect(runner.run({ round: 2, roundDir: "/workspace/round/2" })).rejects.toThrow(/process protocol/);
		}
		const { runner, answer } = channel();
		answer(ended(1, 1)); // nothing was asked
		await tick();
		await expect(runner.run({ round: 1, roundDir: "/workspace/round/1" })).rejects.toThrow(/not asked for/);
	});

	it("a closed channel fails the pending and every later round", async () => {
		const { runner, close } = channel();
		const pending = runner.run({ round: 1, roundDir: "/workspace/round/1" });
		close();
		await expect(pending).rejects.toThrow(/closed the protocol channel/);
		await expect(runner.run({ round: 2, roundDir: "/workspace/round/2" })).rejects.toThrow(/closed/);
	});

	it("a request outside the contract is never written", async () => {
		const { runner, requests } = channel();
		await expect(runner.run({ round: 65, roundDir: "/workspace/round/65" })).rejects.toThrow(/outside the contract/);
		await expect(runner.run({ round: 1, roundDir: "/workspace/../round/1" })).rejects.toThrow(/outside the contract/);
		await tick();
		expect(requests).toEqual([]);
	});
});
