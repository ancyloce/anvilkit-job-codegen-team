import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadTeamConfig } from "../src/config.js";
import { packageRoot } from "../src/contracts.js";
import { type Finding, loadPrompts, type Plan, repairUser, reviewUser } from "../src/team/roles.js";
import { heroFixture, validatorPackage } from "./helpers.js";

// DEC-036 (the B1 recurrence analysis, 2026-10-31): the validator's
// candidate-facing rules reached the team one failed paid run at a time
// (B1 2026-10-27 and runs 3 to 8), because the prompts stated only the rules
// a failure had revealed, ranked them over the plan rule by rule, and gave the
// validator's failure no authority in the repair turn. The source contract
// (agent/team/prompts/contract.md) states every rule; these tests keep it
// complete, tied to the validator's own code, reaching every role, and keep
// the exemplar the validator's certified hero fixture byte for byte.

const promptsDir = path.join(packageRoot, "agent", "team", "prompts");
const contract = readFileSync(path.join(promptsDir, "contract.md"), "utf8");
const exemplar = readFileSync(path.join(promptsDir, "exemplar.md"), "utf8");
const prompts = loadPrompts(path.join(packageRoot, "agent"));

/**
 * Each rule of the source contract: what its line must state, and the
 * validator code that enforces it (a path in the validator package and a
 * string of that file). The B1 runs that failed on a rule are noted.
 */
const rules: Record<string, { states: string[]; enforcedBy: Array<[string, string]> }> = {
	C01: {
		states: ["tsconfig.json", "node_modules, dist, build or out"],
		enforcedBy: [
			["src/source.ts", "refusedDirectories"],
			["src/source.ts", "candidate build configuration is not accepted"],
		],
	},
	C02: { states: ["no two paths differ only in letter case"], enforcedBy: [["src/source.ts", "PATH_ESCAPE"]] },
	C03: {
		states: ["never a .d.ts file", "each declared and non-empty"],
		enforcedBy: [
			["src/source.ts", "declaration files are produced by the build, not accepted from the source"],
			["src/source.ts", "stylesheet is not declared in component.json styles"],
			["src/source.ts", "resource is not declared in component.json resources"],
		],
	},
	C04: {
		states: ["Any other key (name, description, version, category or another) fails"],
		enforcedBy: [["src/source.ts", "component.json: unknown field"]],
	},
	C05: {
		states: ["exactly the brief's", "an exact semver"],
		enforcedBy: [
			["src/source.ts", "IDENTITY_MISMATCH"],
			["src/source.ts", "package.json: version is not an exact semver"],
		],
	},
	C06: { states: ["at least one stylesheet"], enforcedBy: [["src/validate.ts", "the source declares no stylesheet"]] },
	// B1 2026-10-27: a field typed `color`.
	C07: {
		states: ["camelCase (no `_` or `-`)", "text, textarea, number, select, radio, array, object, external, custom"],
		enforcedBy: [
			["src/source.ts", "].name is invalid"],
			["src/source.ts", "declared twice"],
		],
	},
	// B1 run 6: a package.json key `main`.
	C08: {
		states: ["only the keys name, version, description, license and dependencies"],
		enforcedBy: [["src/source.ts", "is not accepted (no scripts, exports, files, workspaces or overrides"]],
	},
	// B1 run 5: a bare lockfileVersion 9.
	C09: {
		states: ["`lockfileVersion: '9.0'`"],
		enforcedBy: [["src/source.ts", "pnpm-lock.yaml: lockfileVersion 9.x is required"]],
	},
	// B1 run 8: the exported object keyed by the Puck type, then wrapped in `components`.
	C10: {
		states: [
			"one flat Puck ComponentConfig",
			"never keyed by the Puck type and never wrapped in `components`",
			"`export default config;`",
		],
		enforcedBy: [
			["fixtures/host/ssr.mjs", "default export has no render function"],
			["fixtures/host/ssr.mjs", "named export config is not the default export"],
			["src/validate.ts", "the entry declaration does not declare"],
		],
	},
	// B1 runs 3 and 6: a Puck field `default`; an undeclared field.
	C11: {
		states: ["exactly the editableFields names", "carries no `default`"],
		enforcedBy: [["fixtures/host/ssr.mjs", "differ from the declared editable fields"]],
	},
	C12: {
		states: ["no dynamic `import()`"],
		enforcedBy: [
			["src/build-worker.ts", "never imported by code"],
			["src/build-worker.ts", "which the Host ABI does not provide"],
			["src/build-worker.ts", "expected one chunk index.js"],
		],
	},
	// B1 run 6: TS2559.
	C13: {
		states: ["without Node types", "`export type`"],
		enforcedBy: [
			["src/build.ts", 'jsx: "react-jsx"'],
			["src/build.ts", "types: []"],
			["src/build-worker.ts", "noEmitOnError: true"],
		],
	},
	C14: {
		states: ["first rendered on a server", "only inside useEffect or an event handler"],
		enforcedBy: [["fixtures/host/ssr.mjs", "renderToString("]],
	},
	C15: { states: ["never copy a prop into state"], enforcedBy: [["src/validate.ts", "did not render the observer's"]] },
	// B1 runs 3, 7 and 8: text defaults not shown, non-display values, an aria-label-only default.
	C16: {
		states: ["verbatim and in one piece", "An aria-label, title, alt or placeholder value is not visible text"],
		enforcedBy: [
			["fixtures/host/ssr.mjs", "rendered HTML lacks the default text"],
			["src/validate.ts", "the rendered text lacks"],
		],
	},
	C17: {
		states: ["The code makes no request", "only through a relative `url()` in a declared stylesheet"],
		enforcedBy: [["src/validate.ts", "which nothing declared"]],
	},
	C18: {
		states: ["clicks the component's first button"],
		enforcedBy: [["src/host-browser-worker.ts", "#root button"]],
	},
	C19: { states: ["No `<style>` element"], enforcedBy: [["src/validate.ts", "the document holds undeclared styles"]] },
	C20: { states: ["`ReactSharedInternals`"], enforcedBy: [["src/validate.ts", "ReactSharedInternals"]] },
	C21: {
		states: ["at least one top-level rule", "not on :root, html or body"],
		enforcedBy: [
			["src/validate.ts", "applies to the rendered component"],
			["src/validate.ts", "takes effect on the rendered component"],
		],
	},
	C22: {
		states: ["no data:, blob:, http:, https: or absolute path"],
		enforcedBy: [
			["src/validate.ts", "which cannot be reviewed"],
			["src/validate.ts", "which is not a shipped stylesheet"],
		],
	},
	C23: { states: ["counterAttribute"], enforcedBy: [["src/source.ts", "counterAttribute"]] },
};

/** The contract's rule lines, by id. */
function ruleLines(): Map<string, string> {
	const lines = new Map<string, string>();
	for (const [, id, text] of contract.matchAll(/^- (C\d\d) (.+)$/gm)) if (id && text) lines.set(id, text);
	return lines;
}

describe("the source contract reaches every role that plans, writes or reviews source", () => {
	for (const role of ["planner", "coder", "code_reviewer", "security_reviewer"] as const) {
		it(`${role}'s system prompt carries the source contract`, () => {
			expect(prompts[role]).toContain(contract.trimEnd());
		});
	}
	for (const role of ["planner", "coder"] as const) {
		it(`${role}'s system prompt carries the exemplar`, () => {
			expect(prompts[role]).toContain(exemplar.trimEnd());
		});
	}
	it("the reviewers and the retrieval specialist get no exemplar, and retrieval no contract", () => {
		expect(prompts.code_reviewer).not.toContain("## Exemplar");
		expect(prompts.security_reviewer).not.toContain("## Exemplar");
		expect(prompts.retrieval).not.toContain("## Source contract");
	});
	it("the contract ranks the validator's failure over the contract, the plan and the findings", () => {
		expect(contract).toContain(
			"Authority, highest first: the independent validator's failure, this source contract (with the exemplar), the plan, the reviewers' findings.",
		);
		expect(contract).toContain("or that would undo a fix of the validator's failure, is void");
	});
});

describe("the source contract states every rule it lists, each tied to the validator code that enforces it", () => {
	const lines = ruleLines();

	it("its rule ids run C01, C02, … without a gap or a repeat, and each has an entry here", () => {
		const ids = [...contract.matchAll(/^- (C\d\d) /gm)].map((m) => m[1] ?? "");
		expect(ids).toEqual(ids.map((_, i) => `C${String(i + 1).padStart(2, "0")}`));
		expect([...ids].sort()).toEqual(Object.keys(rules).sort());
	});

	for (const [id, rule] of Object.entries(rules)) {
		it(`${id} states ${rule.states.map((s) => JSON.stringify(s)).join(" and ")}`, () => {
			const line = lines.get(id);
			expect(line, `${id} is in the contract`).toBeDefined();
			for (const s of rule.states) expect(line).toContain(s);
		});
	}

	// A validator change that removes or rewords a rule's enforcement fails
	// here, so the contract is revised with the validator, never discovered in
	// a paid run. Without the validator's sources these cases skip, unless
	// ANVILKIT_REQUIRE_VALIDATOR says the environment must have them (CI).
	const validatorSources = existsSync(path.join(validatorPackage, "src", "source.ts"));
	describe.skipIf(!validatorSources && !process.env.ANVILKIT_REQUIRE_VALIDATOR)("in the validator's code", () => {
		for (const [id, rule] of Object.entries(rules)) {
			for (const [file, text] of rule.enforcedBy) {
				it(`${id}: ${file} still enforces it (${JSON.stringify(text)})`, () => {
					expect(readFileSync(path.join(validatorPackage, file), "utf8")).toContain(text);
				});
			}
		}
	});

	for (const name of ["contract", "exemplar"]) {
		it(`the ${name} never makes a URL or a colour a text field`, () => {
			const text = name === "contract" ? contract : exemplar;
			expect(text).not.toMatch(/(?:colour|URL)[^.;:()]* is a text field/);
		});
	}
});

// The exemplar is the validator's certified hero fixture, byte for byte: the
// planner and the coder copy a form the validator certifies, never a
// model-written source (candidate output is data, AGENTS.md §6).
describe.skipIf(!existsSync(heroFixture) && !process.env.ANVILKIT_REQUIRE_VALIDATOR)(
	"the exemplar is the validator's certified hero fixture",
	() => {
		const blocks = new Map<string, string>();
		for (const m of exemplar.matchAll(/^([^\n]+?):\n```[a-z]+\n([\s\S]*?)\n```$/gm)) {
			const name = m[1]?.split(" ")[0];
			if (name && m[2] !== undefined) blocks.set(name, m[2]);
		}
		const fixture = (file: string) => readFileSync(path.join(heroFixture, file), "utf8").replace(/\n+$/, "");

		it("it shows the declaration, the package, the lockfile's first lines, the entry, the component and its stylesheet", () => {
			expect([...blocks.keys()]).toEqual([
				"component.json",
				"package.json",
				"pnpm-lock.yaml",
				"src/index.tsx",
				"src/hero.tsx",
				"styles/hero.css",
			]);
		});
		for (const file of ["component.json", "package.json", "src/index.tsx", "src/hero.tsx", "styles/hero.css"]) {
			it(`${file} equals the fixture's`, () => {
				expect(blocks.get(file)).toBe(fixture(file));
			});
		}
		it("pnpm-lock.yaml shows the fixture's lockfile up to its packages section", () => {
			const lock = fixture("pnpm-lock.yaml");
			expect(blocks.get("pnpm-lock.yaml")).toBe(lock.slice(0, lock.indexOf("\npackages:")).replace(/\n+$/, ""));
		});
		it("its entry is one flat ComponentConfig exported as config and as the default export", () => {
			const entry = blocks.get("src/index.tsx") ?? "";
			expect(entry).toMatch(/export const config: ComponentConfig<\w+> = \{/);
			expect(entry).toContain("export default config;");
			expect(entry).not.toMatch(/components:/);
		});
	},
);

describe("the independent validator's failure outranks the findings in the repair and review turns", () => {
	const finding: Finding = {
		id: "puck-config-shape",
		severity: "blocker",
		file: "src/index.tsx",
		line: 6,
		summary: "The config is not keyed as the plan's config step specifies.",
		remediation: "Key it by the Puck type.",
	};
	const failure = { failureCode: "CANDIDATE_TEST_FAILED", detail: "ssr-render: default export has no render function" };

	it("the repair turn puts the validator's failure first and voids a finding that would undo its fix", () => {
		const text = repairUser([finding], failure, "3");
		const lines = text.split("\n");
		expect(lines[1]).toBe(
			"First fix the independent validator's failure: CANDIDATE_TEST_FAILED — ssr-render: default export has no render function",
		);
		expect(lines[2]).toContain(
			"a finding that would undo this fix, or that asks for something the source contract forbids, is void",
		);
		expect(text.indexOf("First fix the independent validator's failure")).toBeLessThan(text.indexOf(finding.id));
	});
	it("a repair turn without a validator failure lists the findings alone", () => {
		const text = repairUser([finding], undefined, "2");
		expect(text).not.toContain("independent validator's failure:");
		expect(text).toContain("The internal reviewers' findings");
		expect(text).toContain(finding.id);
	});

	const plan: Plan = { componentId: "cmp_x", puckType: "X", packageName: "@acme/x", version: "1.0.0", steps: [] };
	it("the reviewers learn the previous round's failure and never ask to undo its fix", () => {
		const text = reviewUser(plan, "2", "(files)", failure);
		expect(text).toContain("The independent validator failed the previous revision: CANDIDATE_TEST_FAILED");
		expect(text).toContain("never ask to undo it");
	});
	it("a first review states no failure", () => {
		expect(reviewUser(plan, "1", "(files)")).not.toContain("failed the previous revision");
	});

	for (const role of ["coder", "code_reviewer"] as const) {
		it(`${role}'s prompt ranks the validator's failure over the plan and the findings`, () => {
			expect(prompts[role]).toMatch(/the independent validator's failure outranks/i);
		});
	}
});

describe("the repair bound gives each paid run one more fix", () => {
	it("team.yaml allows three repair rounds and two review rounds", () => {
		const config = loadTeamConfig(path.join(packageRoot, "team.yaml"));
		expect(config.repairs.max).toBe(3);
		expect(config.reviews.max).toBe(2);
	});
});
