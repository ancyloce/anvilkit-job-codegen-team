// The coordinator's channel to the Go supervisor (anvilkit-job-codegen-
// supervisor): the process protocol of src/protocol.ts, requests on the
// coordinator's stdout, answers on its stdin. The supervisor is the only
// launcher of the candidate: a run-candidate request names the round and its
// directory, nothing else (the program, the identity, the bound and the
// environment are the supervisor's reviewed configuration); the answer is
// the supervisor's own account of how the candidate ended, given after it
// stopped every candidate process and confirmed none is left. One request
// is outstanding at a time. An answer the protocol does not allow — outside
// the contract, for another request or round, or unasked — breaks the
// channel: every pending and later round fails. Diagnostics go to stderr,
// never to the protocol channel.
import { createInterface } from "node:readline";
import {
	type CandidateRoundRefusedError,
	type CandidateRunner,
	type CandidateRunReport,
	type CandidateRunRequest,
	refusedRound,
} from "../executor.js";
import { type Answer, decodeAnswer, encodeRequest, ProtocolViolationError, protocolVersion } from "../protocol.js";

interface Outstanding {
	requestId: number;
	round: number;
	resolve: (r: CandidateRunReport) => void;
	reject: (e: Error) => void;
	/** The caller gave up waiting; the answer is still consumed when it comes. */
	abandoned: boolean;
}

/** The Go supervisor over stdio as a CandidateRunner. */
export class SupervisorRunner implements CandidateRunner {
	private nextRequestId = 1;
	private outstanding: Outstanding | undefined;
	private broken: Error | undefined;

	constructor(
		private readonly out: NodeJS.WritableStream = process.stdout,
		input: NodeJS.ReadableStream = process.stdin,
	) {
		const rl = createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY });
		rl.on("line", (line) => this.answer(line));
		rl.on("close", () => this.break(new Error("the supervisor closed the protocol channel")));
	}

	private break(err: Error): void {
		this.broken ??= err;
		const o = this.outstanding;
		this.outstanding = undefined;
		if (o && !o.abandoned) o.reject(this.broken);
	}

	private answer(line: string): void {
		if (this.broken) return;
		let a: Answer;
		try {
			a = decodeAnswer(line);
		} catch (err) {
			this.break(err as Error);
			return;
		}
		const o = this.outstanding;
		if (!o || a.requestId !== o.requestId || a.round !== o.round) {
			this.break(
				new ProtocolViolationError(`an answer for request ${a.requestId} (round ${a.round}) was not asked for`),
			);
			return;
		}
		this.outstanding = undefined;
		if (o.abandoned) return;
		if (a.type === "refused") {
			o.reject(refusedRound(a.code, a.reason) as CandidateRoundRefusedError);
			return;
		}
		const report: CandidateRunReport = {
			exit: a.exit,
			stop: a.stop,
			descendantsStopped: a.descendantsStopped,
			startedAt: a.startedAt,
			endedAt: a.endedAt,
		};
		if (a.signal !== undefined) report.signal = a.signal;
		o.resolve(report);
	}

	run(req: CandidateRunRequest, signal?: AbortSignal): Promise<CandidateRunReport> {
		if (this.broken) return Promise.reject(this.broken);
		if (this.outstanding)
			return Promise.reject(new Error("a candidate round is outstanding; one round runs at a time"));
		const requestId = this.nextRequestId++;
		let line: string;
		try {
			line = encodeRequest({
				type: "run-candidate",
				protocolVersion,
				requestId,
				round: req.round,
				roundDir: req.roundDir,
			});
		} catch (err) {
			return Promise.reject(err);
		}
		return new Promise((resolve, reject) => {
			const o: Outstanding = { requestId, round: req.round, resolve, reject, abandoned: false };
			this.outstanding = o;
			signal?.addEventListener(
				"abort",
				() => {
					// The round is the supervisor's to stop (the launch's
					// cancellation reaches it directly); its answer still arrives.
					o.abandoned = true;
					reject(new Error("the round was abandoned"));
				},
				{ once: true },
			);
			this.out.write(line);
		});
	}
}
