import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { contractsDir, packageRoot } from "../src/contracts.js";

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
