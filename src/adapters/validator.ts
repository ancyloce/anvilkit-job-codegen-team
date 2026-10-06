// The independent validator's own chain as a bounded child process (the
// validator package's dist/cli.js, anvilkit-job-validator): the trusted
// process of this package never imports the validator or the candidate; it
// hands the sealed source to the chain, reads the certification the chain
// wrote, and classifies with the validator profile's fixed failure-code map.
// A run that cannot be classified — the chain refused to start, ended by a
// signal or its bound, or wrote a certification about other bytes or
// another profile — is an observer failure: never certified, never a repair.
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { ValidatorConfig } from "../config.js";
import { parseStrictObject } from "../contracts.js";
import { sha256 } from "../digest.js";
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
		const failedTo = (failureCode: string, detail: string, certification?: CertificationSummary): ValidationResult => {
			const verdict = this.verdictOf(failureCode);
			this.log("validation", { round: input.round, verdict, failureCode });
			if (verdict === "repairable")
				return { status: "repairable", failureCode, detail, certification: certification ?? placeholder(failureCode) };
			if (verdict === "invalid")
				return { status: "invalid", failureCode, detail, certification: certification ?? placeholder(failureCode) };
			return { status: "infrastructure_failed", failureCode, detail, certification };
		};
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
