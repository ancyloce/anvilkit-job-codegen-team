import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ValidatorCli } from "../src/adapters/validator.js";
import type { ValidatorConfig } from "../src/config.js";
import { contractsDir as contracts } from "../src/contracts.js";
import { sealSource } from "../src/source.js";
import { heroFixture, validatorPackage } from "./helpers.js";

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
					invalid: ["PATH_ESCAPE"],
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
			});
			expect(res.status, what).toBe("infrastructure_failed");
		}
	});

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
		const res = await port.validate({ round: 1, sealedDir, source, sourceRevision: "1" });
		expect(res.status).toBe("certified");
		if (res.status !== "certified") return;
		expect(res.certification.complete).toBe(true);
		expect(res.certification.bindings.sourceDigest).toBe(source.manifestDigest);
		expect(res.certification.checks.every((c) => c.status === "pass")).toBe(true);
		expect(existsSync(path.join(res.certification.dir, "certification.json"))).toBe(true);
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
		const res = await port.validate({ round: 2, sealedDir, source, sourceRevision: "2" });
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
		const r3 = await slow.validate({ round: 3, sealedDir: sealed3, source: src3, sourceRevision: "3" });
		expect(["infrastructure_failed", "certified"]).toContain(r3.status);
		if (r3.status === "infrastructure_failed") expect(r3.failureCode).toBe("OBSERVER_FAILED");
	});
});
