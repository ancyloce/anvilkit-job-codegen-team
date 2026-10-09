import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { bindLaunchIdentity, type Envelope, parseEnvelope } from "../src/coordinator/inputs.js";
import { IdentityMismatchError, identityMismatch } from "../src/identity.js";
import { heroBrief, heroIdentity } from "./helpers.js";

describe("the allocated component identity (P0.8)", () => {
	const dirs: string[] = [];
	afterEach(() => {
		for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
	});
	const source = (files: Record<string, string>) => {
		const dir = mkdtempSync(path.join(tmpdir(), "identity-"));
		dirs.push(dir);
		for (const [name, text] of Object.entries(files)) {
			mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
			writeFileSync(path.join(dir, name), text);
		}
		return dir;
	};
	const declaration = (over: Record<string, unknown> = {}) =>
		JSON.stringify({
			schemaVersion: 1,
			componentId: "cmp_hero_fixed",
			puckType: "Hero",
			entry: "src/index.tsx",
			...over,
		});

	it("names every member of the sealed declaration that differs; a declaration that cannot be read is left to the validator", () => {
		const pkg = JSON.stringify({ name: "@anvilkit/hero-fixed", version: "1.0.0" });
		expect(identityMismatch(source({ "component.json": declaration(), "package.json": pkg }), heroIdentity)).toBe(
			undefined,
		);
		const other = identityMismatch(
			source({
				"component.json": declaration({ puckType: "Banner", componentId: "cmp_banner" }),
				"package.json": JSON.stringify({ name: "@acme/banner" }),
			}),
			heroIdentity,
		);
		expect(other).toMatch(/componentId "cmp_banner"/);
		expect(other).toMatch(/puckType "Banner"/);
		expect(other).toMatch(/package.json names "@acme\/banner"/);
		// No declaration, or one that is not one strict JSON object: the validator's source contract refuses it with its own code.
		expect(identityMismatch(source({ "package.json": pkg }), heroIdentity)).toBe(undefined);
		expect(
			identityMismatch(
				source({ "component.json": '{"puckType":"Hero","puckType":"Banner"}', "package.json": pkg }),
				heroIdentity,
			),
		).toBe(undefined);
	});

	it("the launch envelope's component is parsed with the jobs contract: the revision always, the identity all three or none", () => {
		const envelope = (component: unknown) =>
			JSON.stringify({
				schemaVersion: 1,
				launchId: "lch_1",
				launchKey: "cg-test",
				operationId: "op_1",
				attemptId: "att_1",
				profileId: "codegen-team-dev-v1",
				profileRevision: "2",
				jobKind: "codegen",
				executionEpoch: "1",
				launchEpoch: "1",
				deadline: "2026-10-08T10:00:00Z",
				...(component === undefined ? {} : { component }),
				inputs: [],
			});
		expect(parseEnvelope(envelope(undefined)).component).toBeUndefined();
		expect(parseEnvelope(envelope({ ...heroIdentity, sourceRevision: "1" })).component).toEqual({
			...heroIdentity,
			sourceRevision: "1",
		});
		expect(parseEnvelope(envelope({ sourceRevision: "4" })).component).toEqual({ sourceRevision: "4" });
		for (const partial of [
			heroIdentity,
			{ componentId: heroIdentity.componentId, sourceRevision: "1" },
			{ ...heroIdentity, sourceRevision: "1", version: "1.0.0" },
			{ ...heroIdentity, sourceRevision: "01" },
		])
			expect(() => parseEnvelope(envelope(partial))).toThrow(/launch envelope/);
	});

	it("binds the brief to the envelope's component: the same identity and revision, or IDENTITY_MISMATCH; a revision is always stated", () => {
		const envelope = (component?: Envelope["component"]) => ({ component }) as unknown as Envelope;
		const brief = { ...heroBrief };
		const component = { ...heroIdentity, sourceRevision: "3" };
		expect(bindLaunchIdentity({ ...brief, sourceRevision: "3" }, envelope(component)).sourceRevision).toBe("3");
		expect(bindLaunchIdentity(brief, envelope(component)).sourceRevision).toBe("3");
		expect(bindLaunchIdentity({ ...brief, sourceRevision: "2" }, envelope()).sourceRevision).toBe("2");
		expect(() => bindLaunchIdentity(brief, envelope())).toThrow(/no source revision/);
		expect(() => bindLaunchIdentity({ ...brief, sourceRevision: "2" }, envelope(component))).toThrow(
			IdentityMismatchError,
		);
		expect(() => bindLaunchIdentity(brief, envelope({ ...component, packageName: "@acme/other" }))).toThrow(
			/packageName/,
		);
		// A component naming the revision alone binds the revision; the identity stays the brief's.
		expect(bindLaunchIdentity(brief, envelope({ sourceRevision: "5" }))).toMatchObject({
			...heroIdentity,
			sourceRevision: "5",
		});
		expect(() => bindLaunchIdentity({ ...brief, sourceRevision: "4" }, envelope({ sourceRevision: "5" }))).toThrow(
			/sourceRevision/,
		);
	});
});
