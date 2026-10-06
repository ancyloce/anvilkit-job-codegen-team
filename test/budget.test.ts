// The team's budget rules: every call at the per-send exposure Control
// reserves, and concurrent roles never funded by one remaining send.
import { describe, expect, it } from "vitest";
import { addBudget, type BudgetLimits, moneyAmount, TeamBudget, zeroBudget } from "../src/budget.js";
import type { Role } from "../src/port/model.js";

const limits = (aggregateCalls: number, aggregateExposure: bigint, perSend = 1_000_000n): BudgetLimits => ({
	currency: "USD",
	exposurePerSend: perSend,
	roles: {
		planner: { maxCalls: 2 },
		retrieval: { maxCalls: 2 },
		coder: { maxCalls: 40 },
		code_reviewer: { maxCalls: 3 },
		security_reviewer: { maxCalls: 3 },
	},
	aggregate: { maxCalls: aggregateCalls, exposure: aggregateExposure },
});

const reviewers: readonly Role[] = ["code_reviewer", "security_reviewer"];

describe("TeamBudget", () => {
	it("charges every call at the per-send exposure and states what is left", () => {
		const b = new TeamBudget(limits(50, 50_000_000n));
		const state = addBudget(addBudget(zeroBudget(), b.charge("planner", 1)), b.charge("coder", 9));
		expect(state.total).toEqual({ calls: 10, exposure: "10000000" });
		expect(b.remaining(state, "coder")).toEqual({
			calls: 31,
			exposure: { currency: "USD", amount: "31000000" },
			aggregateCalls: 40,
			aggregateExposure: { currency: "USD", amount: "40000000" },
		});
		expect(b.perSend).toEqual({ currency: "USD", amount: "1000000" });
		expect(() => new TeamBudget(limits(1, 1n, 0n))).toThrow(/positive/);
	});

	it("the historical case: an aggregate of one per-send exposure funds one reviewer send, not two", () => {
		// The reviewed route reserves 1 USD per send at Control. Eleven sends in
		// an aggregate of 12 USD leave one send: one reviewer is funded, the
		// other refuses before it sends — Control would deny it otherwise.
		const b = new TeamBudget(limits(50, 12_000_000n));
		const state = addBudget(zeroBudget(), b.charge("coder", 11));
		const shares = b.reserveParallel(state, reviewers);
		expect(shares.code_reviewer.calls).toBe(1);
		expect(shares.security_reviewer.calls).toBe(0);
		expect(b.affords(shares.security_reviewer)).toBe(false);
		expect(moneyAmount(shares.code_reviewer.exposure) + moneyAmount(shares.security_reviewer.exposure)).toBe(
			1_000_000n,
		);
	});

	it("concurrent shares never draw on one remaining send, for any state", () => {
		let seed = 7;
		const rand = (n: number) => {
			seed = (seed * 1103515245 + 12345) % 2147483648;
			return seed % n;
		};
		for (let i = 0; i < 2000; i++) {
			const per = BigInt(1 + rand(5)) * 10_000n;
			const aggCalls = 1 + rand(30);
			const aggExposure = BigInt(rand(40)) * per + BigInt(rand(10_000));
			const b = new TeamBudget(limits(aggCalls, aggExposure, per));
			let state = zeroBudget();
			const spentCalls = rand(aggCalls + 1);
			state = addBudget(state, b.charge("coder", spentCalls));
			const reviewerSpent = rand(3);
			state = addBudget(state, b.charge("code_reviewer", reviewerSpent));
			const shares = b.reserveParallel(state, reviewers);
			const sumCalls = reviewers.reduce((s, r) => s + (shares[r]?.calls ?? 0), 0);
			const sumExposure = reviewers.reduce((s, r) => s + moneyAmount((shares[r] ?? shares.code_reviewer).exposure), 0n);
			const leftCalls = Math.max(0, aggCalls - state.total.calls);
			const leftExposure = aggExposure - BigInt(state.total.exposure);
			expect(sumCalls).toBeLessThanOrEqual(leftCalls);
			expect(sumExposure).toBeLessThanOrEqual(leftExposure > 0n ? leftExposure : 0n);
			for (const r of reviewers) {
				const s = shares[r];
				expect(s).toBeDefined();
				if (!s) continue;
				expect(s.calls).toBeGreaterThanOrEqual(0);
				expect(s.calls).toBeLessThanOrEqual(Math.max(0, 3 - state.spent[r].calls));
				expect(moneyAmount(s.exposure)).toBe(BigInt(s.calls) * per);
			}
		}
	});

	it("a reservation shrinks by what its role sent", () => {
		const b = new TeamBudget(limits(50, 50_000_000n));
		const share = b.reserveParallel(zeroBudget(), reviewers).code_reviewer;
		const after = TeamBudget.less(share, 1, 1_000_000n);
		expect(after.calls).toBe(share.calls - 1);
		expect(moneyAmount(after.aggregateExposure)).toBe(moneyAmount(share.aggregateExposure) - 1_000_000n);
	});
});
