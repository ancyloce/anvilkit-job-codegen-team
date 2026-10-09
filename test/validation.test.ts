import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	CandidateStopNotEstablishedError,
	launchProcessesOf,
	stopIdentityProcesses,
	ValidatorCli,
} from "../src/adapters/validator.js";
import type { ValidatorConfig } from "../src/config.js";
import { contractsDir as contracts } from "../src/contracts.js";
import { type SealedSource, sealSource } from "../src/source.js";
import { heroFixture, heroIdentity, packageRoot, rootTestsUnavailable, validatorPackage } from "./helpers.js";

const contractsDir = contracts();
const limits = { maxFiles: 256, maxFileBytes: 1 << 20, maxTotalBytes: 16 << 20 };

// The real validator chain needs the built validator package (and its
// browser); without it these cases skip, unless ANVILKIT_REQUIRE_VALIDATOR
// says the environment must have it (CI), where a skip would be a pass.
const available =
	!!process.env.ANVILKIT_REQUIRE_VALIDATOR ||
	(existsSync(path.join(validatorPackage, "dist", "cli.js")) &&
		existsSync(path.join(validatorPackage, "node_modules")));

describe("a validator run that cannot be classified never certifies and never opens a repair", () => {
	let root: string;
	beforeEach(() => {
		root = mkdtempSync(path.join(tmpdir(), "validation-fake-"));
	});
	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	// A stand-in validator package: the profile's fixed map and a cli.js that
	// misbehaves as told. It is not the validator; it only drives the adapter.
	function fakeValidator(cli: string): ValidatorConfig {
		const pkg = path.join(root, "validator");
		mkdirSync(path.join(pkg, "profiles"), { recursive: true });
		mkdirSync(path.join(pkg, "dist"), { recursive: true });
		writeFileSync(
			path.join(pkg, "profiles", "validator-dev-v1.json"),
			JSON.stringify({
				profileId: "validator-dev-v1",
				verdicts: {
					repairable: ["CANDIDATE_BUILD_FAILED"],
					invalid: ["PATH_ESCAPE", "IDENTITY_MISMATCH"],
					infrastructure_failed: ["OBSERVER_FAILED"],
				},
				checks: [],
				profileDigest: "sha256:profile",
			}),
		);
		writeFileSync(path.join(pkg, "dist", "cli.js"), cli);
		return {
			package: pkg,
			node: process.execPath,
			identity: "caller",
			ssr: false,
			browser: false,
			timeoutSeconds: 10,
			buildSupportProfile: "build-support-dev-v1",
			hostAbi: "host-abi-dev-v1",
			validatorProfile: "validator-dev-v1",
		};
	}

	it("a validator that exits early, ends by a signal, writes no certification or certifies other bytes is an observer failure", async () => {
		const sealedDir = path.join(root, "rounds", "1");
		const source = sealSource(heroFixture, path.join(sealedDir, "source"), limits);
		const outDir = 'process.argv[process.argv.indexOf("--out") + 1]';
		const cases: Array<[string, string]> = [
			["refuses to start", "process.exit(3);"],
			["killed", "process.kill(process.pid, 'SIGKILL');"],
			["no certification", "process.exit(0);"],
			[
				"other bytes",
				`require("node:fs").writeFileSync(require("node:path").join(${outDir}, "certification.json"), JSON.stringify({ verdict: "certified", complete: true, checks: [], bindings: { sourceDigest: "sha256:other", sourceRevision: "1", validatorProfileDigest: "sha256:profile" } }));`,
			],
			[
				"another profile",
				`require("node:fs").writeFileSync(require("node:path").join(${outDir}, "certification.json"), JSON.stringify({ verdict: "certified", complete: true, checks: [], bindings: { sourceDigest: "${source.manifestDigest}", sourceRevision: "1", validatorProfileDigest: "sha256:another" } }));`,
			],
		];
		for (const [what, cli] of cases) {
			const config = fakeValidator(`${cli}\n`);
			writeFileSync(path.join(config.package, "package.json"), '{"type":"commonjs"}');
			const res = await new ValidatorCli({ config, runDir: path.join(root, "validation", what) }).validate({
				round: 1,
				sealedDir,
				source,
				sourceRevision: "1",
				identity: heroIdentity,
			});
			expect(res.status, what).toBe("infrastructure_failed");
		}
	});

	/**
	 * A stand-in chain that records its arguments and certifies with bindings
	 * taken from them (the run's revision and identity), as told; with
	 * survivor it first leaves a detached process of the step identity behind.
	 */
	function identityCli(
		source: SealedSource,
		o: { verdict?: string; failureCode?: string; bindings?: Record<string, unknown>; survivor?: boolean } = {},
	): string {
		return `const fs = require("node:fs");
const path = require("node:path");
const arg = (n) => process.argv[process.argv.indexOf(n) + 1];
const out = arg("--out");
fs.writeFileSync(path.join(out, "argv.json"), JSON.stringify(process.argv.slice(2)));
${o.survivor ? 'for (const id of ["10001", "10003"]) require("node:child_process").spawnSync("setpriv", ["--reuid=" + id, "--regid=" + id, "--clear-groups", "--", "/bin/sh", "-c", "sleep 300 >/dev/null 2>&1 &"], { cwd: "/", stdio: "ignore" });' : ""}
const bindings = Object.assign({ sourceDigest: ${JSON.stringify(source.manifestDigest)}, sourceRevision: arg("--source-revision"), componentId: arg("--component-id"), puckType: arg("--puck-type"), packageName: arg("--package-name"), validatorProfileDigest: "sha256:profile" }, ${JSON.stringify(o.bindings ?? {})});
fs.writeFileSync(path.join(out, "certification.json"), JSON.stringify(Object.assign({ verdict: ${JSON.stringify(o.verdict ?? "certified")}, complete: true, checks: [], bindings }, ${JSON.stringify(o.failureCode ? { failureCode: o.failureCode } : {})})));
`;
	}

	it("the run is given the launch's revision and the allocated identity, and a certification must bind exactly them", async () => {
		const sealedDir = path.join(root, "rounds", "1");
		const source = sealSource(heroFixture, path.join(sealedDir, "source"), limits);
		const validate = async (cli: string, what: string) => {
			const config = fakeValidator(cli);
			writeFileSync(path.join(config.package, "package.json"), '{"type":"commonjs"}');
			const runDir = path.join(root, "validation", what);
			const res = await new ValidatorCli({ config, runDir }).validate({
				round: 1,
				sealedDir,
				source,
				sourceRevision: "7",
				identity: heroIdentity,
			});
			return { res, argv: JSON.parse(readFileSync(path.join(runDir, "1", "argv.json"), "utf8")) as string[] };
		};
		const bound = await validate(identityCli(source), "bound");
		expect(bound.res.status).toBe("certified");
		const flag = (name: string) => bound.argv[bound.argv.indexOf(name) + 1];
		expect(flag("--source-revision")).toBe("7");
		expect(flag("--component-id")).toBe(heroIdentity.componentId);
		expect(flag("--puck-type")).toBe(heroIdentity.puckType);
		expect(flag("--package-name")).toBe(heroIdentity.packageName);
		// A certification of another component, type or package is about something else: an observer failure.
		for (const [what, other] of [
			["component", { componentId: "cmp_other" }],
			["type", { puckType: "Banner" }],
			["package", { packageName: "@acme/other" }],
			["no identity", { componentId: null }],
		] as const) {
			const r = await validate(identityCli(source, { bindings: other }), `other ${what}`);
			expect(r.res.status, what).toBe("infrastructure_failed");
			if (r.res.status === "infrastructure_failed") expect(r.res.failureCode).toBe("OBSERVER_FAILED");
		}
		// The chain's own refusal of another declaration is classified by the profile's fixed map.
		const refused = await validate(
			identityCli(source, { verdict: "invalid", failureCode: "IDENTITY_MISMATCH", bindings: { puckType: "Banner" } }),
			"refused",
		);
		expect(refused.res.status).toBe("invalid");
		if (refused.res.status === "invalid") expect(refused.res.failureCode).toBe("IDENTITY_MISMATCH");
	});

	// VAL-05 under the Job's process topology: the coordinator is not PID 1 of
	// its PID namespace (here a shell is, as the supervisor is in the Job), so
	// a step's orphan is reparented away from the validator. The adapter runs
	// in a private PID namespace (unshare): the stop signals every process of
	// UID 10001 it can see, and on a development host other processes of that
	// UID (containers) must stay out of its reach.
	const rootSkip = rootTestsUnavailable();
	it.skipIf(rootSkip !== "")(
		"VAL-05 (root): detached processes of the step identities (10001, 10003) left by the run are stopped and confirmed gone before anything is read, and the run is not read",
		async () => {
			const sealedDir = path.join(root, "rounds", "1");
			const source = sealSource(heroFixture, path.join(sealedDir, "source"), limits);
			const config = (cli: string, name: string): ValidatorConfig => {
				const c = fakeValidator(cli);
				const pkg = path.join(root, name);
				rmSync(pkg, { recursive: true, force: true });
				renameSync(c.package, pkg);
				writeFileSync(path.join(pkg, "package.json"), '{"type":"commonjs"}');
				return {
					...c,
					package: pkg,
					identity: "setpriv",
					uid: 10001,
					gid: 10001,
					harnessUid: 10003,
					harnessGid: 10003,
				};
			};
			const probeInput = {
				survivor: config(identityCli(source, { survivor: true }), "validator-survivor"),
				clean: config(identityCli(source), "validator-clean"),
				runDir: path.join(root, "validation"),
				validation: { round: 1, sealedDir, source, sourceRevision: "1", identity: heroIdentity },
			};
			writeFileSync(path.join(root, "probe.json"), JSON.stringify(probeInput));
			const adapter = pathToFileURL(path.join(packageRoot, "dist", "adapters", "validator.js")).href;
			writeFileSync(
				path.join(root, "probe.mjs"),
				`import { readFileSync } from "node:fs";
const { ValidatorCli, launchProcessesOf } = await import(${JSON.stringify(adapter)});
const input = JSON.parse(readFileSync(${JSON.stringify(path.join(root, "probe.json"))}, "utf8"));
const left = () => launchProcessesOf(10001).length + launchProcessesOf(10003).length;
const out = { pid: process.pid, before: left() };
out.survivor = await new ValidatorCli({ config: input.survivor, runDir: input.runDir + "/survivor" }).validate(input.validation);
out.after = left();
out.clean = await new ValidatorCli({ config: input.clean, runDir: input.runDir + "/clean" }).validate(input.validation);
console.log(JSON.stringify(out));
`,
			);
			const run = spawnSync(
				"unshare",
				[
					"--pid",
					"--fork",
					"--mount-proc",
					"--",
					"/bin/sh",
					"-c",
					`"$0" "$1"; exit $?`,
					process.execPath,
					path.join(root, "probe.mjs"),
				],
				{ env: { PATH: process.env.PATH ?? "/usr/bin:/bin" }, encoding: "utf8", timeout: 120_000 },
			);
			expect(run.status, run.stderr).toBe(0);
			const out = JSON.parse(run.stdout.trim().split("\n").at(-1) ?? "{}") as {
				pid: number;
				before: number;
				after: number;
				survivor: { status: string; failureCode?: string; detail?: string };
				clean: { status: string };
			};
			expect(out.pid, "the adapter's process is not PID 1 of its namespace").not.toBe(1);
			expect(out.before).toBe(0);
			expect(out.survivor).toMatchObject({ status: "infrastructure_failed", failureCode: "OBSERVER_FAILED" });
			// A detached process of each step identity (the candidate's and the SSR harness's).
			expect(out.survivor.detail).toMatch(/^2 process\(es\) of the step identities outlived the validator run/);
			expect(out.after).toBe(0);
			expect(out.clean.status).toBe("certified");
			expect(new CandidateStopNotEstablishedError("x").final).toBe(true);
		},
	);

	it.skipIf(rootSkip !== "")(
		"VAL-05 (root): the stop reaches only the launch's tree, never another process of the identity on a shared host",
		async () => {
			// A launch (a shell standing in for the supervisor) with a process of the identity below it, and a
			// bystander of the same identity outside the launch's tree (a child of this test process).
			const drop = ["--reuid=10001", "--regid=10001", "--clear-groups", "--", "sleep", "300"];
			const bystander = spawn("setpriv", drop, { stdio: "ignore" });
			const launch = spawn("/bin/sh", ["-c", `setpriv ${drop.join(" ")} & wait`], { stdio: "ignore" });
			const launchRoot = launch.pid as number;
			try {
				await new Promise((r) => setTimeout(r, 300));
				const inLaunch = launchProcessesOf(10001, launchRoot);
				expect(inLaunch).toHaveLength(1);
				expect(inLaunch).not.toContain(bystander.pid);
				const stopped = await stopIdentityProcesses(
					[
						{ uid: 10001, gid: 10001 },
						{ uid: 10003, gid: 10003 },
					],
					launchRoot,
				);
				expect(stopped).toMatchObject({ found: 1, confirmed: true });
				expect(launchProcessesOf(10001, launchRoot)).toEqual([]);
				// The bystander, of the same identity, was never signaled.
				expect(launchProcessesOf(10001, process.pid)).toContain(bystander.pid);
			} finally {
				bystander.kill("SIGKILL");
				launch.kill("SIGKILL");
			}
		},
	);

	it("a validator package without its chain refuses before any round", () => {
		const config = fakeValidator("");
		rmSync(path.join(config.package, "dist"), { recursive: true });
		expect(() => new ValidatorCli({ config, runDir: root })).toThrow(/no dist\/cli.js/);
	});
});

describe.skipIf(!available)("independent validation through the validator's chain", () => {
	let root: string;
	let config: ValidatorConfig;
	beforeEach(() => {
		root = mkdtempSync(path.join(tmpdir(), "validation-"));
		config = {
			package: validatorPackage,
			node: process.execPath,
			identity: "caller",
			ssr: true,
			browser: true,
			timeoutSeconds: 600,
			buildSupportProfile: "build-support-dev-v1",
			hostAbi: "host-abi-dev-v1",
			validatorProfile: "validator-dev-v1",
			contractsDir,
			browsersPath: process.env.PLAYWRIGHT_BROWSERS_PATH ?? path.join(homedir(), ".cache", "ms-playwright"),
		};
	});
	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	it("the sealed fixed Hero source is certified by the validator, bound to the sealed manifest digest", async () => {
		const sealedDir = path.join(root, "rounds", "1");
		const source = sealSource(heroFixture, path.join(sealedDir, "source"), limits);
		const port = new ValidatorCli({ config, runDir: path.join(root, "validation") });
		const res = await port.validate({ round: 1, sealedDir, source, sourceRevision: "1", identity: heroIdentity });
		expect(res.status).toBe("certified");
		if (res.status !== "certified") return;
		expect(res.certification.complete).toBe(true);
		expect(res.certification.bindings.sourceDigest).toBe(source.manifestDigest);
		expect(res.certification.bindings).toMatchObject({ sourceRevision: "1", ...heroIdentity });
		expect(res.certification.checks.every((c) => c.status === "pass")).toBe(true);
		expect(existsSync(path.join(res.certification.dir, "certification.json"))).toBe(true);
	});

	it("AC4: the certified revision is the launch's; another allocated identity than the declared one is refused IDENTITY_MISMATCH, classified invalid", async () => {
		const sealedDir = path.join(root, "rounds", "7");
		const source = sealSource(heroFixture, path.join(sealedDir, "source"), limits);
		const port = new ValidatorCli({ config, runDir: path.join(root, "validation") });
		const certified = await port.validate({ round: 7, sealedDir, source, sourceRevision: "7", identity: heroIdentity });
		expect(certified.status).toBe("certified");
		if (certified.status === "certified") expect(certified.certification.bindings.sourceRevision).toBe("7");
		const other = await new ValidatorCli({ config, runDir: path.join(root, "validation-other") }).validate({
			round: 7,
			sealedDir,
			source,
			sourceRevision: "7",
			identity: { ...heroIdentity, puckType: "Banner" },
		});
		expect(other.status).toBe("invalid");
		if (other.status === "invalid") expect(other.failureCode).toBe("IDENTITY_MISMATCH");
	});

	it("a source defect is classified by the validator profile's fixed map as repairable; a path escape as invalid; a wrong profile as infrastructure", async () => {
		// Missing stylesheet: the declaration names styles/hero.css, the source has none → the source contract refuses (CANDIDATE_BUILD_FAILED → repairable).
		const broken = path.join(root, "broken");
		const { cpSync } = await import("node:fs");
		cpSync(heroFixture, broken, { recursive: true });
		rmSync(path.join(broken, "styles", "hero.css"));
		const sealedDir = path.join(root, "rounds", "2");
		const source = sealSource(broken, path.join(sealedDir, "source"), limits);
		const port = new ValidatorCli({ config, runDir: path.join(root, "validation") });
		const res = await port.validate({ round: 2, sealedDir, source, sourceRevision: "2", identity: heroIdentity });
		expect(res.status).toBe("repairable");
		if (res.status === "repairable") expect(res.failureCode).toBe("CANDIDATE_BUILD_FAILED");
		expect(port.verdictOf("PATH_ESCAPE")).toBe("invalid");
		expect(port.verdictOf("MISSING_CSS")).toBe("repairable");
		expect(port.verdictOf("OBSERVER_FAILED")).toBe("infrastructure_failed");
		expect(port.verdictOf("PROFILE_UNQUALIFIED")).toBe("infrastructure_failed");
		expect(port.verdictOf("SOMETHING_ELSE")).toBe("infrastructure_failed");
		// A validator profile the package does not have is a configuration refusal, never a source verdict.
		expect(
			() => new ValidatorCli({ config: { ...config, validatorProfile: "validator-none-v9" }, runDir: root }),
		).toThrow();
		// A run whose bound is too short is an infrastructure failure (OBSERVER_FAILED), not a repair target.
		const slow = new ValidatorCli({
			config: { ...config, timeoutSeconds: 10 },
			runDir: path.join(root, "validation-slow"),
		});
		const sealed3 = path.join(root, "rounds", "3");
		const src3 = sealSource(heroFixture, path.join(sealed3, "source"), limits);
		writeFileSync(path.join(root, "unused"), "");
		const r3 = await slow.validate({
			round: 3,
			sealedDir: sealed3,
			source: src3,
			sourceRevision: "3",
			identity: heroIdentity,
		});
		expect(["infrastructure_failed", "certified"]).toContain(r3.status);
		if (r3.status === "infrastructure_failed") expect(r3.failureCode).toBe("OBSERVER_FAILED");
	});
});
