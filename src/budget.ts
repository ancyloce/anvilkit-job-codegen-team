// The team's budget (DD-02 §3, DD-03 §1): every role of an attempt draws on
// one operation budget, and Control's ledger is the authority on it. What
// Control holds for a physical send is the route's per-send exposure: the
// Model Proxy reserves the route's reviewed full bound (its max_exposure)
// for every send, whatever a caller declares, and Control admits a send
// only when that reservation, the other sends in flight and the cost
// already consumed fit the operation's allocation. The team therefore
// declares and accounts every call at exactly that amount, in integer money
// of one currency: a call costs at most what Control reserved for it, so
// an aggregate that the operation's allocation covers is never exceeded by
// the team's own sends, and allowances handed to roles that send
// concurrently never let two sends draw on one reserved unit. Declaring
// less than Control reserves (the earlier per-role exposurePerCall) let the
// team's own accounting fund sends Control would deny.

import type { Money } from "./adapters/sidecar.js";
import type { Role } from "./port/model.js";

export const roles: readonly Role[] = ["planner", "retrieval", "coder", "code_reviewer", "security_reviewer"];

/** Money arithmetic on the contract's decimal strings (one currency, no fraction). */
export function moneyAmount(m: Money): bigint {
	if (!/^-?(0|[1-9][0-9]{0,29})$/.test(m.amount)) throw new Error(`not a money amount: ${m.amount}`);
	return BigInt(m.amount);
}

export function money(currency: string, amount: bigint): Money {
	return { currency, amount: amount.toString() };
}

/** The allowance a caller has left for one role and in aggregate before a call. */
export interface Allowance {
	calls: number;
	exposure: Money;
	aggregateCalls: number;
	aggregateExposure: Money;
}

export interface Spend {
	calls: number;
	/** Integer money as a decimal string (the state is checkpointed as JSON). */
	exposure: string;
}

/** The accounting the graph state carries (a reducer adds charges). */
export interface BudgetState {
	spent: Record<Role, Spend>;
	total: Spend;
}

export function zeroBudget(): BudgetState {
	const spent = {} as Record<Role, Spend>;
	for (const r of roles) spent[r] = { calls: 0, exposure: "0" };
	return { spent, total: { calls: 0, exposure: "0" } };
}

/** The state reducer: charges add up per role and in total. */
export function addBudget(a: BudgetState, b: BudgetState): BudgetState {
	const spent = {} as Record<Role, Spend>;
	for (const r of roles) {
		spent[r] = {
			calls: a.spent[r].calls + b.spent[r].calls,
			exposure: (BigInt(a.spent[r].exposure) + BigInt(b.spent[r].exposure)).toString(),
		};
	}
	return {
		spent,
		total: {
			calls: a.total.calls + b.total.calls,
			exposure: (BigInt(a.total.exposure) + BigInt(b.total.exposure)).toString(),
		},
	};
}

export interface BudgetLimits {
	currency: string;
	/** What Control reserves for one send on the route (the route's max_exposure). */
	exposurePerSend: bigint;
	roles: Record<Role, { maxCalls: number }>;
	aggregate: { maxCalls: number; exposure: bigint };
}

/** The budget rules of one run over its reviewed limits. */
export class TeamBudget {
	constructor(readonly limits: BudgetLimits) {
		if (limits.exposurePerSend <= 0n) throw new Error("the per-send exposure must be positive");
	}

	/** The exposure every call declares (maxExposure on the relay) and is accounted at. */
	get perSend(): Money {
		return money(this.limits.currency, this.limits.exposurePerSend);
	}

	/** The charge of calls by a role: each at the per-send exposure. */
	charge(role: Role, calls: number): BudgetState {
		const b = zeroBudget();
		const exposure = (BigInt(calls) * this.limits.exposurePerSend).toString();
		b.spent[role] = { calls, exposure };
		b.total = { calls, exposure };
		return b;
	}

	/** The allowance left for a role from the limits and the state's accounting. */
	remaining(state: BudgetState, role: Role): Allowance {
		const roleCalls = this.limits.roles[role].maxCalls - state.spent[role].calls;
		const c = this.limits.currency;
		return {
			calls: roleCalls,
			exposure: money(c, BigInt(Math.max(0, roleCalls)) * this.limits.exposurePerSend),
			aggregateCalls: this.limits.aggregate.maxCalls - state.total.calls,
			aggregateExposure: money(c, this.limits.aggregate.exposure - BigInt(state.total.exposure)),
		};
	}

	/** Whether an allowance funds one more send. */
	affords(a: Allowance): boolean {
		const per = this.limits.exposurePerSend;
		return (
			a.calls > 0 && a.aggregateCalls > 0 && moneyAmount(a.exposure) >= per && moneyAmount(a.aggregateExposure) >= per
		);
	}

	/**
	 * Non-overlapping reservations for roles that send concurrently: the
	 * aggregate left in the state is divided in whole sends, in the fixed
	 * role order — each role takes at most what its own allowance funds and
	 * an equal share (rounded up) of the sends the unreserved aggregate still
	 * funds. The shares never sum to more than the aggregate, one remaining
	 * send funds one role only, and a role left nothing refuses before it
	 * sends. A share is the role's whole allowance for the fan-out: its
	 * aggregate view is its share.
	 */
	reserveParallel(state: BudgetState, parallel: readonly Role[]): Record<Role, Allowance> {
		const per = this.limits.exposurePerSend;
		let sends = Math.max(0, this.limits.aggregate.maxCalls - state.total.calls);
		const funded = this.limits.aggregate.exposure - BigInt(state.total.exposure);
		sends = Math.min(sends, funded <= 0n ? 0 : Number(funded / per));
		const shares = {} as Record<Role, Allowance>;
		parallel.forEach((role, i) => {
			const own = Math.max(0, this.remaining(state, role).calls);
			const share = Math.min(own, Math.ceil(sends / (parallel.length - i)));
			const exposure = money(this.limits.currency, BigInt(share) * per);
			shares[role] = { calls: share, exposure, aggregateCalls: share, aggregateExposure: exposure };
			sends -= share;
		});
		return shares;
	}

	/** The allowance left of a reservation after the sends a role made against it. */
	static less(a: Allowance, sends: number, exposure: bigint): Allowance {
		return {
			calls: a.calls - sends,
			exposure: money(a.exposure.currency, moneyAmount(a.exposure) - exposure),
			aggregateCalls: a.aggregateCalls - sends,
			aggregateExposure: money(a.aggregateExposure.currency, moneyAmount(a.aggregateExposure) - exposure),
		};
	}
}
