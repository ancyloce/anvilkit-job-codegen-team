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
