// The contract schemas the team consumes (contracts/jobs and
// contracts/components of anvilkit-agent-contracts): read from a directory
// named by the environment or found beside this package in the parent
// checkout, compiled once. What the coordinator produces (the result manifest
// it submits, the source manifest it records) is checked against the same
// schemas Control and the validator validate with; what it reads from a
// candidate is parsed strictly and never trusted for its shape.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { type ParseOptions, printParseErrorCode, visit } from "jsonc-parser";

export const componentsSchemaId = "urn:anvilkit:components:v1";
export const jobsSchemaId = "urn:anvilkit:jobs:v1";

export const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** The directory holding components/component.schema.json and jobs/job.schema.json. */
export function contractsDir(): string {
	const env = process.env.ANVILKIT_CODEGEN_TEAM_CONTRACTS_DIR;
	if (env) return env;
	for (const candidate of [
		path.join(packageRoot, "contracts"),
		path.resolve(packageRoot, "..", "..", "..", "contracts"),
	]) {
		if (existsSync(path.join(candidate, "jobs", "job.schema.json"))) return candidate;
	}
	throw new Error(
		"contracts not found: set ANVILKIT_CODEGEN_TEAM_CONTRACTS_DIR to a directory holding components/component.schema.json and jobs/job.schema.json",
	);
}

let compiled: Ajv2020 | undefined;

function ajv(): Ajv2020 {
	if (compiled) return compiled;
	const dir = contractsDir();
	// strictRequired is off for the same reason the validator turns it off:
	// the jobs contract states "no failureCode under a certified verdict" as
	// then/not/required inside allOf.
	const a = new Ajv2020({ strict: true, strictRequired: false, allErrors: false, allowUnionTypes: true });
	addFormats.default ? addFormats.default(a) : (addFormats as unknown as (a: Ajv2020) => void)(a);
	for (const rel of ["components/component.schema.json", "jobs/job.schema.json"]) {
		a.addSchema(JSON.parse(readFileSync(path.join(dir, rel), "utf8")));
	}
	compiled = a;
	return a;
}

export type ContractRef = `${typeof componentsSchemaId}#/$defs/${string}` | `${typeof jobsSchemaId}#/$defs/${string}`;

/** Validates an instance against one $defs entry; returns the first error text or undefined. */
export function validateAgainst(ref: ContractRef, instance: unknown): string | undefined {
	const a = ajv();
	let v = a.getSchema(ref);
	if (!v) {
		a.addSchema({ $id: `urn:anvilkit:codegen-team:ref:${ref}`, $ref: ref }, ref);
		v = a.getSchema(ref);
	}
	if (!v) throw new Error(`contract ref ${ref} does not compile`);
	if (v(instance)) return undefined;
	const e = v.errors?.[0];
	return e ? `${e.instancePath || "/"} ${e.message ?? "invalid"}` : "invalid";
}

/** Validates an instance against an ad-hoc JSON schema (the team's own typed documents). */
export function validateSchema(schema: Record<string, unknown>, instance: unknown): string | undefined {
	// strictRequired is off as for the contracts: a then/required clause
	// beside a properties declaration is how a conditional member is stated.
	const a = new Ajv2020({ strict: true, strictRequired: false, allErrors: false, allowUnionTypes: true });
	const v = a.compile(schema);
	if (v(instance)) return undefined;
	const e = v.errors?.[0];
	return e ? `${e.instancePath || "/"} ${e.message ?? "invalid"}` : "invalid";
}

/**
 * Strict JSON parsing (contracts.md §4): one document, an object, no
 * comments, no trailing commas, no trailing data, no duplicate keys. The
 * syntax — strings, escapes, numbers, nesting — is jsonc-parser's scanner
 * and visitor, configured to refuse comments and trailing commas; this
 * package adds only the duplicate-key policy: every member name of an
 * object, as decoded by the scanner (so `"a"` and `"\u0061"` are the same
 * name), must be unique within that object, whatever the values. The value
 * itself is JSON.parse's, which agrees with the visitor on what is a
 * document and keeps the last duplicate silently — hence the visitor first.
 */
export function parseStrictObject(text: string, what: string): Record<string, unknown> {
	assertStrictDocument(text, what);
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch (err) {
		throw new Error(`${what}: ${(err as Error).message}`);
	}
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${what}: not a JSON object`);
	return value as Record<string, unknown>;
}

const strictJson: ParseOptions = { disallowComments: true, allowTrailingComma: false, allowEmptyContent: false };

function assertStrictDocument(text: string, what: string): void {
	const members: Array<Set<string>> = [];
	let problem: string | undefined;
	visit(
		text,
		{
			onObjectBegin: () => {
				members.push(new Set());
			},
			onObjectEnd: () => {
				members.pop();
			},
			onObjectProperty: (name) => {
				const own = members[members.length - 1];
				if (!own) return;
				if (own.has(name)) problem ??= `duplicate key ${JSON.stringify(name)}`;
				own.add(name);
			},
			onError: (code, offset) => {
				problem ??= `${printParseErrorCode(code)} at offset ${offset}`;
			},
		},
		strictJson,
	);
	if (problem) throw new Error(`${what}: ${problem}`);
}
