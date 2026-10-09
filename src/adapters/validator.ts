// The independent validator's own chain as a bounded child process (the
// validator package's dist/cli.js, anvilkit-job-validator): the trusted
// process of this package never imports the validator or the candidate; it
// hands the sealed source to the chain, reads the certification the chain
// wrote, and classifies with the validator profile's fixed failure-code map.
// A run that cannot be classified — the chain refused to start, ended by a
// signal or its bound, or wrote a certification about other bytes, another
// revision, another component identity or another profile — is an observer
// failure: never certified, never a repair.
//
// The chain's build, SSR and browser steps run as the candidate identity
// (setpriv). In the Job this process is not PID 1: an orphan a step leaves
// is reparented to the supervisor (the child subreaper, this process's
// parent), outside the chain's own view of its steps (VAL-05). So once the
// chain has ended and before anything of its run is read, this process
// looks for every live process of the step identity below the supervisor
// from its own read of /proc, stops them as that identity (it has no
// CAP_KILL) and confirms none is left. A run that left one is not read
// (OBSERVER_FAILED); a stop that cannot be confirmed ends the attempt
// without a stage, as an unconfirmed candidate stop does in the supervisor.
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { ValidatorConfig } from "../config.js";
import { parseStrictObject } from "../contracts.js";
import { sha256 } from "../digest.js";
import { CandidateRoundRefusedError } from "../executor.js";
import type { CertificationSummary, ValidationInput, ValidationPort, ValidationResult } from "../validation.js";

interface ValidatorProfileDoc {
	profileId: string;
	verdicts: Record<string, string[]>;
	checks: string[];
	profileDigest: string;
}

export interface ValidatorCliOptions {
	config: ValidatorConfig;
	/** Where runs go: one directory per round (the certification, the artifacts, the work tree). */
	runDir: string;
	log?: (event: string, fields?: Record<string, unknown>) => void;
}

export class ValidatorCli implements ValidationPort {
	private readonly profile: ValidatorProfileDoc;
	private readonly log: (event: string, fields?: Record<string, unknown>) => void;

	constructor(private readonly o: ValidatorCliOptions) {
		const profilePath = path.join(o.config.package, "profiles", `${o.config.validatorProfile}.json`);
		const doc = parseStrictObject(
			readFileSync(profilePath, "utf8"),
			"validator profile",
		) as unknown as ValidatorProfileDoc;
		if (doc.profileId !== o.config.validatorProfile || typeof doc.verdicts !== "object")
			throw new Error(`validator profile ${profilePath} is not ${o.config.validatorProfile}`);
		this.profile = doc;
		this.log = o.log ?? (() => {});
		if (!existsSync(path.join(o.config.package, "dist", "cli.js")))
			throw new Error(`validator package ${o.config.package} has no dist/cli.js`);
	}

	/** The verdict the validator profile assigns to a failure code (the fixed map, never a guess). */
	verdictOf(code: string): "repairable" | "invalid" | "infrastructure_failed" | "canceled" {
		for (const [verdict, codes] of Object.entries(this.profile.verdicts)) {
			if (codes.includes(code)) return verdict as "repairable" | "invalid" | "infrastructure_failed" | "canceled";
		}
		return "infrastructure_failed";
	}

	async validate(input: ValidationInput, signal?: AbortSignal): Promise<ValidationResult> {
		const c = this.o.config;
		const out = path.join(this.o.runDir, String(input.round));
		mkdirSync(out, { recursive: true, mode: 0o755 });
		const args = [
			path.join(c.package, "dist", "cli.js"),
			path.join(input.sealedDir, "source"),
			"--source-revision",
			input.sourceRevision,
			"--component-id",
			input.identity.componentId,
			"--puck-type",
			input.identity.puckType,
			"--package-name",
			input.identity.packageName,
			"--out",
			out,
			"--validator-profile",
			c.validatorProfile,
		];
		if (c.identity === "setpriv") args.push("--step-identity", "setpriv");
		if (!c.ssr) args.push("--no-ssr");
		if (!c.browser) args.push("--no-browser");
		const env: Record<string, string> = {
			PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
			HOME: out,
			NODE_ENV: "production",
		};
		if (c.contractsDir) env.ANVILKIT_VALIDATOR_CONTRACTS_DIR = c.contractsDir;
		if (c.browsersPath) env.PLAYWRIGHT_BROWSERS_PATH = c.browsersPath;
		const run = await runBounded(c.node, args, { cwd: c.package, env, timeoutMs: c.timeoutSeconds * 1000, signal });
		writeFileSync(path.join(out, "validator.log"), `${run.stdout}\n--- stderr ---\n${run.stderr}`, { mode: 0o600 });
		// Nothing of the run is read while a process of a step identity may still write.
		const left =
			c.identity === "setpriv"
				? await stopIdentityProcesses([
						{ uid: c.uid ?? 10001, gid: c.gid ?? 10001 },
						{ uid: c.harnessUid ?? 10003, gid: c.harnessGid ?? 10003 },
					])
				: undefined;
		if (left && !left.confirmed) throw new CandidateStopNotEstablishedError(left.detail);
		const failedTo = (failureCode: string, detail: string, certification?: CertificationSummary): ValidationResult => {
			const verdict = this.verdictOf(failureCode);
			this.log("validation", { round: input.round, verdict, failureCode });
			if (verdict === "repairable")
				return { status: "repairable", failureCode, detail, certification: certification ?? placeholder(failureCode) };
			if (verdict === "invalid")
				return { status: "invalid", failureCode, detail, certification: certification ?? placeholder(failureCode) };
			return { status: "infrastructure_failed", failureCode, detail, certification };
		};
		if (left && left.found > 0)
			return failedTo(
				"OBSERVER_FAILED",
				`${left.found} process(es) of the step identities outlived the validator run (stopped and confirmed gone); the run is not read`,
			);
		if (run.timedOut || run.signal)
			return failedTo("OBSERVER_FAILED", `the validator run ended by ${run.timedOut ? "its time bound" : run.signal}`);
		if (run.code === 1) {
			// The source contract or the build refused: {code, message} on stderr.
			const line = run.stderr
				.trim()
				.split("\n")
				.filter((l) => l.startsWith("{"))
				.at(-1);
			let code = "CANDIDATE_BUILD_FAILED";
			let message = run.stderr.trim().slice(-300);
			if (line) {
				try {
					const parsed = JSON.parse(line) as { code?: string; message?: string };
					if (parsed.code) code = parsed.code;
					if (parsed.message) message = parsed.message;
				} catch {
					// the message stays the stderr tail
				}
			}
			return failedTo(code, message);
		}
		if (run.code !== 0)
			return failedTo("PROFILE_UNQUALIFIED", run.stderr.trim().slice(-300) || `validator exited ${run.code}`);
		const certPath = path.join(out, "certification.json");
		if (!existsSync(certPath)) return failedTo("OBSERVER_FAILED", "the validator exited 0 without a certification");
		const raw = readFileSync(certPath);
		const cert = JSON.parse(raw.toString("utf8")) as {
			verdict: string;
			failureCode?: string;
			complete: boolean;
			checks: Array<{ name: string; status: string; detail?: string }>;
			bindings: Record<string, unknown> & {
				componentId?: string;
				puckType?: string;
				packageName?: string;
				sourceDigest?: string;
				sourceRevision?: string;
				validatorProfileDigest?: string;
			};
		};
		const summary: CertificationSummary = {
			verdict: cert.verdict,
			failureCode: cert.failureCode,
			complete: cert.complete,
			checks: cert.checks,
			bindings: cert.bindings,
			digest: sha256(raw),
			dir: out,
		};
		// The certification is about exactly the sealed bytes and this profile; anything else is an observer failure, never a verdict about the source.
		if (
			cert.bindings.sourceDigest !== input.source.manifestDigest ||
			cert.bindings.sourceRevision !== input.sourceRevision
		)
			return failedTo(
				"OBSERVER_FAILED",
				`the certification binds source ${cert.bindings.sourceDigest}@${cert.bindings.sourceRevision}, the sealed source is ${input.source.manifestDigest}@${input.sourceRevision}`,
				summary,
			);
		if (cert.bindings.validatorProfileDigest !== this.profile.profileDigest)
			return failedTo(
				"OBSERVER_FAILED",
				"the certification binds another validator profile than the configured one",
				summary,
			);
		if (cert.verdict === "certified") {
			if (!cert.complete) return failedTo("OBSERVER_FAILED", "a certified verdict without a complete run", summary);
			// A certification binds exactly the allocated identity the run was given (the chain refuses another declaration itself).
			const id = input.identity;
			if (
				cert.bindings.componentId !== id.componentId ||
				cert.bindings.puckType !== id.puckType ||
				cert.bindings.packageName !== id.packageName
			)
				return failedTo(
					"OBSERVER_FAILED",
					`the certification binds ${cert.bindings.componentId}/${cert.bindings.puckType}/${cert.bindings.packageName}, the allocated identity is ${id.componentId}/${id.puckType}/${id.packageName}`,
					summary,
				);
			this.log("validation", { round: input.round, verdict: "certified" });
			return { status: "certified", certification: summary };
		}
		const detail = cert.checks
			.filter((x) => x.status === "fail")
			.map((x) => `${x.name}: ${x.detail ?? ""}`)
			.join("; ")
			.slice(0, 1000);
		return failedTo(cert.failureCode ?? "OBSERVER_FAILED", detail || cert.verdict, summary);
	}
}

/** The stop of the step identity's processes after a validator run could not be confirmed: nothing proves that none still writes. */
export class CandidateStopNotEstablishedError extends CandidateRoundRefusedError {
	constructor(detail: string) {
		super("STOP_NOT_ESTABLISHED", detail, true);
		this.name = "CandidateStopNotEstablishedError";
		this.message = `the candidate identity's processes after a validator run: ${detail}`;
	}
}

/**
 * The launch's process tree: the supervisor that started this process (its
 * parent when it started — PID 1 of the Job container, the child subreaper
 * every orphan of the launch is reparented to). Only processes below it
 * belong to the launch; on a shared PID namespace (a development host)
 * nothing outside it is ever counted or signaled.
 */
const launchRoot = process.ppid;

/**
 * The live processes (no zombies) of the launch — below root on the parent
 * chain — with a real, effective, saved or filesystem UID of uid, from this
 * process's own read of /proc.
 */
export function launchProcessesOf(uid: number, root: number = launchRoot): number[] {
	const procs = new Map<number, { ppid: number; live: boolean; uid: boolean }>();
	for (const name of readdirSync("/proc")) {
		if (!/^[0-9]+$/.test(name)) continue;
		let status: string;
		try {
			status = readFileSync(`/proc/${name}/status`, "utf8");
		} catch {
			continue; // exited between the listing and the read
		}
		const state = /^State:\s+(\S)/m.exec(status)?.[1];
		const uids = /^Uid:\s+(.*)$/m.exec(status)?.[1]?.trim().split(/\s+/).map(Number) ?? [];
		procs.set(Number(name), {
			ppid: Number(/^PPid:\s+(\d+)/m.exec(status)?.[1] ?? 0),
			live: state !== "Z" && state !== "X",
			uid: uids.includes(uid),
		});
	}
	const below = (pid: number): boolean => {
		let cur = procs.get(pid)?.ppid ?? 0;
		for (let hops = 0; cur > 0 && hops < 1024; hops++) {
			if (cur === root) return true;
			cur = procs.get(cur)?.ppid ?? 0;
		}
		return false;
	};
	return [...procs].filter(([pid, p]) => p.live && p.uid && pid !== root && below(pid)).map(([pid]) => pid);
}

const stopRounds = 40;

/**
 * Stops every live process of the step identities (the validator's
 * candidate and SSR harness identities) in the launch's tree: as each
 * identity (the reviewed setpriv drop; this process holds no CAP_KILL) a
 * shell signals exactly the processes of that identity found, round after
 * round, and this process confirms from its own read of /proc, never from
 * a helper, that none is left. In the Job no other process of these
 * identities runs while the coordinator validates: the coder's rounds are
 * stopped and confirmed by the supervisor before their answer. Without the
 * supervisor as its parent any more, nothing is established.
 */
export async function stopIdentityProcesses(
	identities: Array<{ uid: number; gid: number }>,
	root: number = launchRoot,
): Promise<{ found: number; confirmed: boolean; detail: string }> {
	if (identities.some((i) => i.uid === 0 || i.gid === 0)) throw new Error("a step identity is never root");
	if (root === launchRoot && process.ppid !== launchRoot)
		return { found: 0, confirmed: false, detail: "the supervisor that started this process is gone" };
	const liveOf = () => identities.map((i) => ({ ...i, pids: launchProcessesOf(i.uid, root) }));
	let live = liveOf();
	const count = () => live.reduce((n, i) => n + i.pids.length, 0);
	const found = count();
	for (let round = 0; round < stopRounds && count() > 0; round++) {
		for (const identity of live.filter((i) => i.pids.length > 0))
			await runBounded(
				"setpriv",
				[
					`--reuid=${identity.uid}`,
					`--regid=${identity.gid}`,
					"--clear-groups",
					"--inh-caps=-all",
					"--bounding-set=-all",
					"--no-new-privs",
					"--",
					"/bin/sh",
					"-c",
					'kill -KILL "$@"',
					"sh",
					...identity.pids.map(String),
				],
				{ cwd: "/", env: { PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin" }, timeoutMs: 10_000 },
			).catch(() => undefined);
		await new Promise((r) => setTimeout(r, Math.min(25 * (round + 1), 250)));
		live = liveOf();
	}
	const left = live.filter((i) => i.pids.length > 0);
	return {
		found,
		confirmed: left.length === 0,
		detail: left.map((i) => `${i.pids.length} process(es) of UID ${i.uid} are still alive after the stop`).join("; "),
	};
}

function placeholder(failureCode: string): CertificationSummary {
	return { verdict: "-", failureCode, complete: false, checks: [], bindings: {}, digest: "", dir: "" };
}

interface BoundedRun {
	code: number | null;
	signal: string | null;
	timedOut: boolean;
	stdout: string;
	stderr: string;
}

/** Runs a child with a bounded lifetime and bounded captured output; a bound or the signal kills its whole group. */
export function runBounded(
	command: string,
	args: string[],
	o: { cwd: string; env: Record<string, string>; timeoutMs: number; signal?: AbortSignal },
): Promise<BoundedRun> {
	return new Promise((resolve, reject) => {
		let child: ChildProcess;
		try {
			child = spawn(command, args, { cwd: o.cwd, env: o.env, stdio: ["ignore", "pipe", "pipe"], detached: true });
		} catch (err) {
			reject(err);
			return;
		}
		let stdout = "";
		let stderr = "";
		let timedOut = false;
		const cap = (s: string, c: Buffer) => (s.length > 1 << 20 ? s : s + c.toString());
		child.stdout?.on("data", (c: Buffer) => {
			stdout = cap(stdout, c);
		});
		child.stderr?.on("data", (c: Buffer) => {
			stderr = cap(stderr, c);
		});
		const killGroup = () => {
			if (child.pid) {
				try {
					process.kill(-child.pid, "SIGKILL");
				} catch {
					// already gone
				}
			}
		};
		const timer = setTimeout(() => {
			timedOut = true;
			killGroup();
		}, o.timeoutMs);
		const onAbort = () => killGroup();
		o.signal?.addEventListener("abort", onAbort, { once: true });
		child.on("error", (err) => {
			clearTimeout(timer);
			reject(err);
		});
		child.on("exit", (code, signal) => {
			clearTimeout(timer);
			o.signal?.removeEventListener("abort", onAbort);
			resolve({ code, signal, timedOut, stdout, stderr });
		});
	});
}
