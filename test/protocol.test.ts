// The coordinator's codec held to the process protocol's single source:
// the contract copy (contract/, verbatim from anvilkit-agent-contracts
// jobs/codegen/) — its digests, constants and every fixture — and what the
// fixtures cannot state: the lines themselves.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { packageRoot } from "../src/contracts.js";
import {
	decodeAnswer,
	encodeRequest,
	encodeResult,
	finalRefusals,
	maxLineBytes,
	maxResultBytes,
	protocolSchema,
	protocolVersion,
	type RunCandidate,
	type TeamResult,
} from "../src/protocol.js";

const contract = path.join(packageRoot, "contract");
const fixtures = JSON.parse(readFileSync(path.join(contract, "fixtures.json"), "utf8")) as {
	schema: string;
	cases: Array<{ name: string; ref: string; valid: boolean; instance: unknown }>;
};

describe("process protocol", () => {
	it("the contract copy is the one SOURCE records", () => {
		const recorded = new Map<string, string>();
		for (const line of readFileSync(path.join(contract, "SOURCE"), "utf8").split("\n")) {
			if (!line.trim() || line.startsWith("#")) continue;
			const [p, digest] = line.split(" ");
			recorded.set(p as string, digest as string);
		}
		for (const f of ["protocol.schema.json", "fixtures.json"]) {
			const digest = `sha256:${createHash("sha256")
				.update(readFileSync(path.join(contract, f)))
				.digest("hex")}`;
			expect(recorded.get(`jobs/codegen/${f}`), f).toBe(digest);
		}
	});

	it("the codec's constants are the contract's", () => {
		const defs = (protocolSchema() as { $defs: Record<string, { const?: unknown; enum?: string[] }> }).$defs;
		expect(defs.protocolVersion?.const).toBe(protocolVersion);
		expect(defs.maxLineBytes?.const).toBe(maxLineBytes);
		expect(defs.maxResultBytes?.const).toBe(maxResultBytes);
		expect(defs.refusalCode?.enum).toEqual(expect.arrayContaining([...finalRefusals]));
	});

	it("every fixture: what the coordinator writes is refused outside the contract, what it reads is accepted exactly as the contract says", () => {
		const seen = new Set<string>();
		for (const c of fixtures.cases) {
			const ref = c.ref.replace("#/$defs/", "");
			seen.add(ref);
			const attempt = (): unknown => {
				switch (ref) {
					case "runCandidate":
						return encodeRequest(c.instance as RunCandidate);
					case "teamResult":
						return encodeResult(c.instance as TeamResult);
					case "candidateEnded":
					case "refused":
					case "answer":
						return decodeAnswer(JSON.stringify(c.instance));
					default:
						throw new Error(`no codec for ${ref}`);
				}
			};
			if (c.valid) expect(attempt, c.name).not.toThrow();
			else expect(attempt, c.name).toThrow(/process protocol/);
		}
		expect([...seen].sort()).toEqual(["answer", "candidateEnded", "refused", "runCandidate", "teamResult"]);
	});

	it("an answer line is parsed strictly and bounded", () => {
		const ok = `{"type":"refused","protocolVersion":1,"requestId":1,"round":1,"code":"TEAM_ENDED","reason":"x"}`;
		expect(decodeAnswer(ok).type).toBe("refused");
		for (const [name, line] of Object.entries({
			duplicate: ok.replace(`"round":1`, `"round":1,"round":2`),
			"duplicate by escape": ok.replace(`"round":1`, `"round":1,"r\\u006fund":2`),
			trailing: `${ok} {}`,
			comment: ok.replace(`{"type"`, `{/* x */"type"`),
			oversize: ok.replace(`"reason":"x"`, `"reason":"${"x".repeat(maxLineBytes)}"`),
			"not an object": `["refused"]`,
			empty: "",
		}))
			expect(() => decodeAnswer(line), name).toThrow(/process protocol/);
	});

	it("a request line is one line of the contract's shape", () => {
		const line = encodeRequest({
			type: "run-candidate",
			protocolVersion: 1,
			requestId: 3,
			round: 2,
			roundDir: "/workspace/round/2",
		});
		expect(line.endsWith("\n")).toBe(true);
		expect(line.indexOf("\n")).toBe(line.length - 1);
		expect(JSON.parse(line)).toEqual({
			type: "run-candidate",
			protocolVersion: 1,
			requestId: 3,
			round: 2,
			roundDir: "/workspace/round/2",
		});
	});
});
