import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { loadTeamConfig } from "../src/config.js";
import { contractsDir, packageRoot } from "../src/contracts.js";
import { heroFixture, validatorPackage } from "./helpers.js";

// The editable field types the prompts state are exactly the component
// contract's: a plan with a type the contract lacks fails every repair round
// (plan 0005 §11.5, 2026-10-27: the planner typed a field "color" and the
// reviewers held the coder to the plan).
function editableFieldTypes(node: unknown): string[] | undefined {
	if (!node || typeof node !== "object") return undefined;
	const record = node as Record<string, unknown>;
	const fields = record.editableFields as { items?: { properties?: { type?: { enum?: unknown } } } } | undefined;
	const values = fields?.items?.properties?.type?.enum;
	if (Array.isArray(values)) return values.map(String);
	for (const value of Object.values(record)) {
		const found = editableFieldTypes(value);
		if (found) return found;
	}
	return undefined;
}

describe("the team prompts state the component contract's editable field types", () => {
	const schema = JSON.parse(readFileSync(path.join(contractsDir(), "components", "component.schema.json"), "utf8"));
	const types = editableFieldTypes(schema);

	it("the contract declares them", () => {
		expect(types?.length).toBeGreaterThan(0);
	});

	for (const role of ["planner", "coder", "code_reviewer"]) {
		it(`${role} names exactly those types, in the contract's order`, () => {
			const text = readFileSync(path.join(packageRoot, "agent", "team", "prompts", `${role}.md`), "utf8");
			expect(text).toContain((types ?? []).join(", "));
		});
	}
});

// The validator fails a candidate whose non-empty text or textarea default is
// missing from the rendered text (jobs/validator src/validate.ts, the
// browser-host check), and a Puck field configuration with a `default` does
// not compile: B1 run 3 (plan 0005 §11.8, 2026-10-28) rendered a dismiss label
// only as an aria-label and, at the reviewer's request, put `default` into a
// TextField.
describe("the team prompts state the rendered-default and Puck-field rules", () => {
	for (const role of ["planner", "coder", "code_reviewer"]) {
		it(`${role} states both rules`, () => {
			const text = readFileSync(path.join(packageRoot, "agent", "team", "prompts", `${role}.md`), "utf8");
			expect(text).toContain("is rendered as visible text");
			expect(text).toContain("Puck field configurations carry no `default`");
		});
	}
});

// The validator requires pnpm-lock.yaml's lockfileVersion to be a string
// starting with "9." (jobs/validator src/source.ts): B1 run 5 (plan 0005
// §11.10, 2026-10-29) read the code reviewer's "lockfileVersion 9" literally,
// raised a blocker against '9.0', and the coder's bare 9 failed the build.
describe("the team prompts state the lockfile version exactly", () => {
	const prompt = (role: string) =>
		readFileSync(path.join(packageRoot, "agent", "team", "prompts", `${role}.md`), "utf8");

	for (const role of ["coder", "code_reviewer"]) {
		it(`${role} states lockfileVersion '9.0' and keeps it over any finding`, () => {
			const text = prompt(role);
			expect(text).toContain("`lockfileVersion: '9.0'`");
			expect(text).toContain("a lockfileVersion other than '9.0'");
		});
	}

	for (const role of ["planner", "coder", "code_reviewer", "security_reviewer", "retrieval"]) {
		it(`${role} never states another lockfile version`, () => {
			// A version given as anything but the quoted '9.0': 9, 9.0 unquoted, '9', "9.0".
			expect(prompt(role)).not.toMatch(/lockfileVersion:?\s*(?!'9\.0')['"]?\d/);
		});
	}
});

// B1 run 6 (plan 0005 §11.11, 2026-10-29) failed on a package.json key the
// validator refuses (jobs/validator src/source.ts allowedPackageKeys), and on a
// Puck field the declaration lacks, added at a security reviewer's request (the
// validator's SSR check compares the config's fields with editableFields). The
// code reviewer also raised a lockfile finding over the packages section, which
// the validator's lockfile check never reads.
describe("the team prompts state the package, field-set, plan-bound and lockfile-section rules", () => {
	const prompt = (role: string) =>
		readFileSync(path.join(packageRoot, "agent", "team", "prompts", `${role}.md`), "utf8");
	// The keys jobs/validator src/source.ts accepts in package.json.
	const validatorPackageKeys = ["dependencies", "description", "license", "name", "version"];

	for (const role of ["planner", "coder", "code_reviewer"]) {
		it(`${role} allows exactly the package.json keys the validator accepts`, () => {
			const m = prompt(role).match(/only the keys ((?:[a-z]+, )+[a-z]+) and ([a-z]+)/);
			expect(m, "the prompt names the package.json keys").not.toBeNull();
			const keys = [...(m?.[1] ?? "").split(", "), m?.[2] ?? ""].sort();
			expect(keys).toEqual(validatorPackageKeys);
		});
	}

	for (const role of ["planner", "coder", "code_reviewer", "security_reviewer"]) {
		it(`${role} keeps the Puck config's fields exactly the editableFields`, () => {
			const text = prompt(role);
			expect(text).toContain("Puck config's `fields`");
			expect(text).toContain("exactly the `editableFields` of component.json");
		});
	}

	it("the coder adds no field, prop or capability beyond the plan, whatever a finding asks", () => {
		const text = prompt("coder");
		expect(text).toContain("Never add a field, prop or capability the plan does not state");
		expect(text).toContain(
			"a package.json key other than these five, a field, prop or capability the plan does not state)",
		);
	});

	for (const role of ["code_reviewer", "security_reviewer"]) {
		it(`${role} never asks for a field, prop or capability beyond the plan`, () => {
			expect(prompt(role)).toContain("never ask for a field, prop or capability the plan does not state");
		});
	}

	for (const role of ["coder", "code_reviewer", "security_reviewer"]) {
		it(`${role} fixes a security concern within the plan`, () => {
			const text = prompt(role);
			expect(text).toContain("a checked safe constant");
			expect(text).toContain("behavior the plan does not require");
		});
	}

	for (const role of ["code_reviewer", "security_reviewer"]) {
		it(`${role} reports a conflict with required functionality and asks for a decision`, () => {
			expect(prompt(role)).toContain(
				"if the fix would change functionality the plan requires, report the conflict and ask for a decision",
			);
		});
	}

	it("the coder changes nothing outside the plan for a finding that asks for a decision", () => {
		expect(prompt("coder")).toContain(
			"a finding that reports a conflict and asks for a decision changes nothing outside the plan",
		);
	});

	for (const role of ["code_reviewer", "security_reviewer"]) {
		it(`${role} does not treat the lockfile's packages or snapshots sections alone as a finding`, () => {
			expect(prompt(role)).toContain(
				"the presence or absence of `packages` or `snapshots` sections alone is not a finding",
			);
		});
	}

	for (const role of ["coder", "code_reviewer"]) {
		it(`${role} states the lockfile importer rules the validator checks`, () => {
			const text = prompt(role);
			expect(text).toContain(
				"exactly one importer '.' with no devDependencies, optionalDependencies or peerDependencies",
			);
			expect(text).toContain("specifier and version equal to the declared version");
		});
	}
});

// B1 run 7 (plan 0005 §11.12, 2026-10-29) declared a URL, a storage key, an
// enumeration and two booleans as text fields with non-empty defaults; the
// validator's rendered-default rule failed them, and the reviewers' plan bound
// undid the coder's attempt to show them. The validator also renders the first
// declared text or textarea field with a value of its own and looks for that
// value in the visible text (jobs/validator src/validate.ts nonceField).
describe("the team prompts state the display-field rule", () => {
	const prompt = (role: string) =>
		readFileSync(path.join(packageRoot, "agent", "team", "prompts", `${role}.md`), "utf8");

	for (const role of ["planner", "coder", "code_reviewer"]) {
		it(`${role} keeps text fields for display text and non-display values out of them`, () => {
			const text = prompt(role);
			expect(text).toContain("A text or textarea field is display text");
			expect(text).toContain(
				"(a URL, a storage key, an identifier or a CSS value such as a colour) is never a text or textarea field with a non-empty default",
			);
			expect(text).toContain("a text field with an empty default whose empty value the code replaces with a constant");
			expect(text).toContain("Fixed choices and booleans are select or radio fields");
			expect(text).toContain("The first text or textarea field of editableFields is display text");
		});
	}

	for (const role of ["planner", "coder", "code_reviewer", "security_reviewer", "retrieval"]) {
		it(`${role} never makes a URL or a colour a text field`, () => {
			expect(prompt(role)).not.toMatch(/(?:colour|URL)[^.;:()]* is a text field/);
		});
	}

	it("the coder turns a planned non-display text field into an allowed form, whatever a finding asks", () => {
		const text = prompt("coder");
		expect(text).toContain(
			"keep the field's name, give it an empty default and use the plan's default as that constant",
		);
		expect(text).toContain("a non-display value in a text field with a non-empty default, a package.json key");
	});

	it("the code reviewer accepts that form and never asks to show a non-display value", () => {
		const text = prompt("code_reviewer");
		expect(text).toContain("follows the source contract and is no finding");
		expect(text).toContain("never ask to show a URL, a storage key or another non-display value as text");
	});
});

// The package and lockfile rules the prompts state must be the validator's
// own, not a copy that drifts from it. A source written exactly to the coder
// prompt passes the validator's source contract (jobs/validator
// src/source.ts readSource), and the departures of B1 runs 5 and 6 (a bare
// lockfileVersion 9, a `main` key; plan 0005 §11.10–§11.11) are refused. The
// rules come from the prompt text and the verdicts from the validator package,
// so a change on either side that breaks their agreement fails here, in team
// CI, before an image is built or a paid run is spent. Without the built
// validator these cases skip, unless ANVILKIT_REQUIRE_VALIDATOR says the
// environment must have it (CI).
const validatorBuilt =
	existsSync(path.join(validatorPackage, "dist", "source.js")) &&
	existsSync(path.join(validatorPackage, "node_modules"));

describe.skipIf(!validatorBuilt && !process.env.ANVILKIT_REQUIRE_VALIDATOR)(
	"a source written to the coder prompt's package and lockfile rules passes the validator's source contract",
	() => {
		const coder = readFileSync(path.join(packageRoot, "agent", "team", "prompts", "coder.md"), "utf8");
		const listed = coder.match(/only the keys ((?:[a-z]+, )+[a-z]+) and ([a-z]+)/);
		const promptKeys = [...(listed?.[1] ?? "").split(", "), listed?.[2] ?? ""];
		const promptLockfileVersion = coder.match(/`lockfileVersion: ('[^']+')`/)?.[1];
		let check: (dir: string) => void;
		let dir: string;

		beforeAll(async () => {
			const dist = (file: string) => pathToFileURL(path.join(validatorPackage, "dist", file)).href;
			const { readSource } = await import(dist("source.js"));
			const { loadProfiles } = await import(dist("profiles.js"));
			// The validator finds the contract schemas through ANVILKIT_VALIDATOR_CONTRACTS_DIR,
			// as the team's validator adapter passes it (src/adapters/validator.ts); its own
			// fallback, a contracts/ beside the parent's jobs/, is absent in this repository's CI.
			const previous = process.env.ANVILKIT_VALIDATOR_CONTRACTS_DIR;
			process.env.ANVILKIT_VALIDATOR_CONTRACTS_DIR = previous ?? contractsDir();
			let profiles: ReturnType<typeof loadProfiles>;
			try {
				profiles = loadProfiles();
			} finally {
				if (previous === undefined) delete process.env.ANVILKIT_VALIDATOR_CONTRACTS_DIR;
			}
			check = (source) =>
				readSource(source, { sourceRevision: "1", profile: profiles.build, limits: profiles.validator.limits });
		});
		beforeEach(() => {
			dir = mkdtempSync(path.join(tmpdir(), "prompt-source-"));
			cpSync(heroFixture, dir, { recursive: true });
		});
		afterEach(() => {
			rmSync(dir, { recursive: true, force: true });
		});

		const packageJson = () => JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8"));
		const writePackage = (doc: Record<string, unknown>) =>
			writeFileSync(path.join(dir, "package.json"), `${JSON.stringify(doc, null, 2)}\n`);
		const writeLockfileVersion = (value: string) => {
			const lock = path.join(dir, "pnpm-lock.yaml");
			writeFileSync(lock, readFileSync(lock, "utf8").replace(/^lockfileVersion: .*$/m, `lockfileVersion: ${value}`));
		};

		it("the prompt names its keys and its lockfile version", () => {
			expect(listed, "the coder prompt names the package.json keys").not.toBeNull();
			expect(promptLockfileVersion, "the coder prompt states the lockfileVersion line").toBeDefined();
		});

		it("a package.json with exactly the prompt's keys is accepted", () => {
			const doc = packageJson();
			expect(Object.keys(doc).filter((k) => !promptKeys.includes(k))).toEqual([]);
			expect(
				promptKeys.filter((k) => !(k in doc)),
				"the fixture carries every listed key",
			).toEqual([]);
			writePackage(Object.fromEntries(promptKeys.map((k) => [k, doc[k]])));
			expect(() => check(dir)).not.toThrow();
		});

		// Keys a coder adds to a package.json by habit; the prompt lists none.
		const unlisted: Record<string, unknown> = {
			main: "src/index.tsx",
			module: "src/index.tsx",
			types: "src/index.tsx",
			exports: { ".": "./src/index.tsx" },
			scripts: { build: "tsc" },
			type: "module",
			private: true,
			files: ["src"],
			peerDependencies: { react: "19.3.0" },
			devDependencies: { typescript: "6.0.3" },
		};
		for (const [key, value] of Object.entries(unlisted)) {
			it(`a package.json key the prompt does not list (${key}) is refused`, () => {
				expect(promptKeys).not.toContain(key);
				writePackage({ ...packageJson(), [key]: value });
				expect(() => check(dir)).toThrow(`package.json: field ${key} is not accepted`);
			});
		}

		it("the lockfileVersion the prompt states is accepted and the bare number 9 is refused", () => {
			writeLockfileVersion(promptLockfileVersion ?? "");
			expect(() => check(dir)).not.toThrow();
			writeLockfileVersion("9");
			expect(() => check(dir)).toThrow("lockfileVersion 9.x is required");
		});
	},
);

// The planner writes the whole plan in one call, so it holds the route's full
// output bound: B1 run 2's plan was cut at 2048 of 4096 tokens and the Proxy
// ended the call UPSTREAM_TOOL_ARGUMENTS_INVALID (plan 0005 §11.7). The parent
// repository's tools/check-model-routes.py ties route.maxTokens to the Model
// Proxy's route bound.
describe("the planner holds the route's output bound", () => {
	it("team.yaml gives the planner route.maxTokens", () => {
		const config = loadTeamConfig(path.join(packageRoot, "team.yaml"));
		expect(config.roles.planner.maxOutputTokens).toBe(config.route.maxTokens);
	});
});
