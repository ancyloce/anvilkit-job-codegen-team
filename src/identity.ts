// The allocated component identity (P0.8, SEC-12): the componentId and
// puckType of the frozen brief — repeated exactly by the launch envelope's
// component when the launcher states one — and the npm package name. The Pi
// coder writes the declaration (component.json) and the package
// (package.json), but the identity is not its to choose: before anything
// validates a sealed source, the coordinator compares what it declares with
// the allocated identity, and a difference ends the round as
// IDENTITY_MISMATCH — never a certification of another type or package.
import { lstatSync, readFileSync } from "node:fs";
import path from "node:path";
import { parseStrictObject } from "./contracts.js";

export interface ComponentIdentity {
	componentId: string;
	puckType: string;
	packageName: string;
}

export const identityMismatchCode = "IDENTITY_MISMATCH";

/** The launch's own inputs name two identities (the envelope's component and the brief): nothing runs. */
export class IdentityMismatchError extends Error {
	readonly code = identityMismatchCode;
	constructor(message: string) {
		super(message);
		this.name = "IdentityMismatchError";
	}
}

/**
 * How a sealed source's declaration differs from the allocated identity, or
 * undefined when it declares exactly that identity. A component.json or
 * package.json that is absent or not one strict JSON object declares
 * nothing to compare: the validator's source contract refuses such a source
 * with its own code, and a certification must bind the allocated identity
 * whatever it read (adapters/validator.ts).
 */
export function identityMismatch(sourceDir: string, expected: ComponentIdentity): string | undefined {
	const declaration = readObject(path.join(sourceDir, "component.json"));
	const pkg = readObject(path.join(sourceDir, "package.json"));
	const problems: string[] = [];
	if (declaration && declaration.componentId !== expected.componentId)
		problems.push(
			`component.json declares componentId ${JSON.stringify(declaration.componentId)}, the allocated one is ${expected.componentId}`,
		);
	if (declaration && declaration.puckType !== expected.puckType)
		problems.push(
			`component.json declares puckType ${JSON.stringify(declaration.puckType)}, the allocated one is ${expected.puckType}`,
		);
	if (pkg && pkg.name !== expected.packageName)
		problems.push(`package.json names ${JSON.stringify(pkg.name)}, the allocated package is ${expected.packageName}`);
	return problems.length > 0 ? problems.join("; ").slice(0, 1000) : undefined;
}

/**
 * How a sealed source's package version differs from the brief's, or
 * undefined when package.json declares exactly that version. The brief
 * freezes the version (a refinement's is its base's with the patch number
 * raised by one, DEC-063), and a release names the version the certified
 * source declares; a refinement starts from a source that still declares
 * the base's, so nothing but this check makes the new version reach the
 * package. A package.json that cannot be read declares nothing to compare:
 * the validator refuses such a source with its own code.
 */
export function versionMismatch(sourceDir: string, version: string): string | undefined {
	const pkg = readObject(path.join(sourceDir, "package.json"));
	if (pkg && pkg.version !== version)
		return `package.json declares version ${JSON.stringify(pkg.version)}, the brief's version is ${version}: set package.json's version to exactly ${version}`.slice(
			0,
			1000,
		);
	return undefined;
}

function readObject(file: string): Record<string, unknown> | undefined {
	try {
		if (!lstatSync(file).isFile()) return undefined;
		return parseStrictObject(readFileSync(file, "utf8"), path.basename(file));
	} catch {
		return undefined;
	}
}
