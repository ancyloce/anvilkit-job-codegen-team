import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RelayRequest } from "../src/adapters/sidecar.js";
import type { Allowance } from "../src/budget.js";
import { CodingExecutor, type ExecutorConfig, SourceWriterConflictError } from "../src/executor.js";
import { inventory, readTree } from "../src/source.js";
import { FakeSidecar } from "./doubles.js";

import { heroFixture, heroScript, localRunner } from "./helpers.js";

describe("CodingExecutor", () => {
	let sidecar: FakeSidecar;
	let workspace: string;
	let seal: string;
	const remaining = (): Allowance => ({
		calls: 40,
		exposure: { currency: "USD", amount: "800000" },
		aggregateCalls: 60,
		aggregateExposure: { currency: "USD", amount: "900000" },
	});
	const config = (): ExecutorConfig => ({
		workspace,
		sealDir: seal,
		candidateSocket: sidecar.candidateSocket,
		routeId: "controlled-openai-v1",
		callIdPrefix: "att_team",
		model: { contextWindow: 128_000, maxTokens: 4096 },
		compaction: { enabled: false, reserveTokens: 8192, keepRecentTokens: 4096 },
		tools: ["read", "write", "edit", "ls", "grep", "find"],
		systemPrompt: "You are the Pi coder of the team. TRUSTED CODER PROMPT.",
		deadline: new Date(Date.now() + 5 * 60_000),
		limits: {
			maxCalls: 30,
			maxOutputTokens: 4096,
			exposurePerSend: { currency: "USD", amount: "20000" },
		},
		sourceLimits: { maxFiles: 256, maxFileBytes: 1 << 20, maxTotalBytes: 16 << 20 },
		maxSessionBytes: 8 << 20,
	});
	beforeEach(async () => {
		sidecar = new FakeSidecar("executor");
		await sidecar.start();
		workspace = mkdtempSync(path.join(tmpdir(), "team-ws-"));
		seal = mkdtempSync(path.join(tmpdir(), "team-seal-"));
	});
	afterEach(async () => {
		await sidecar.stop();
		rmSync(workspace, { recursive: true, force: true });
		rmSync(seal, { recursive: true, force: true });
	});

	it("one round: the coder writes the complete source through controlled calls; the seal records the validator's manifest digest", async () => {
		heroScript(sidecar);
		const ex = new CodingExecutor(config(), localRunner());
		const r = await ex.round({
			round: 1,
			kind: "code",
			prompt: "Implement the Hero component as planned.",
			sourceRevision: "1",
			remaining: remaining(),
		});
		expect(r.report.exit).toBe(0);
		expect(r.outcome?.ended).toBe("completed");
		expect(r.source).toBeDefined();
		const expected = inventory(readTree(heroFixture, { maxFiles: 100, maxFileBytes: 1 << 20, maxTotalBytes: 8 << 20 }));
		expect(r.source?.manifestDigest).toBe(expected.manifestDigest);
		expect(r.source?.files.map((f) => f.path)).toEqual(expected.files.map((f) => f.path));
		// The sealed copy is immutable and root-only in the Job; here: unwritable files.
		const sealedIndex = path.join(r.sealedDir, "source", "src", "index.tsx");
		expect(statSync(sealedIndex).mode & 0o777).toBe(0o400);
		expect(r.sessionFile).toBeDefined();
		expect(r.sessionDigest).toMatch(/^sha256:/);
		expect(r.sessionUsage?.assistantMessages).toBe(expected.files.length + 1);
		expect(r.outcome?.calls).toBe(expected.files.length + 1);
		// Every call went through the candidate socket under the round's identities, one send each.
		expect(sidecar.requests.every((q) => q.callId.startsWith("att_team:r1:coder:"))).toBe(true);
		expect(sidecar.totalSends()).toBe(expected.files.length + 1);
		expect(sidecar.requests[0]?.messages[0]?.content).toContain("TRUSTED CODER PROMPT");
		expect(readdirSync(path.join(workspace, "round", "1"))).toEqual(["round.json"]);
	});

	it("a repair round continues the sealed session and the sealed source; a drifted workspace source is refused", async () => {
		heroScript(sidecar);
		const ex = new CodingExecutor(config(), localRunner());
		const first = await ex.round({
			round: 1,
			kind: "code",
			prompt: "Implement.",
			sourceRevision: "1",
			remaining: remaining(),
		});
		const before = sidecar.requests.length;
		sidecar.script = (req: RelayRequest) => {
			const last = req.messages.at(-1);
			if (last?.role === "user" && /finding/i.test(last.content))
				return {
					text: ["Repairing."],
					tools: [
						{
							id: "tc_fix",
							name: "edit",
							arguments: JSON.stringify({
								path: "src/hero.tsx",
								edits: [{ oldText: "ak-hero__cta", newText: "ak-hero__cta ak-hero__cta--fixed" }],
							}),
						},
					],
				};
			return { text: ["Repaired."] };
		};
		const second = await ex.round({
			round: 2,
			kind: "repair",
			prompt: "Finding F1: the CTA class must carry the fixed modifier.",
			sourceRevision: "2",
			continueFrom: first,
			remaining: remaining(),
		});
		expect(second.outcome?.ended).toBe("completed");
		expect(second.source?.manifestDigest).not.toBe(first.source?.manifestDigest);
		const hero = readFileSync(path.join(second.sealedDir, "source", "src", "hero.tsx"), "utf8");
		expect(hero).toContain("ak-hero__cta--fixed");
		// The continued session carried the first round's history into the repair round's first call.
		const firstRepairCall = sidecar.requests[before];
		expect(firstRepairCall?.callId).toBe("att_team:r2:coder:1");
		expect(firstRepairCall?.messages.filter((m) => m.role === "assistant").length).toBeGreaterThan(5);
		expect(sidecar.totalSends()).toBe(sidecar.requests.length);
		// A third round after someone else touched the workspace source does not start.
		writeFileSync(path.join(workspace, "w", "source", "src", "extra.ts"), "export {};\n");
		await expect(
			ex.round({
				round: 3,
				kind: "repair",
				prompt: "Again.",
				sourceRevision: "3",
				continueFrom: second,
				remaining: remaining(),
			}),
		).rejects.toThrow(/not the sealed source of round 2/);
	});

	it("an allowance of one call admits exactly one: the ordinal is not the spend, the second call is refused before a send", async () => {
		heroScript(sidecar);
		const ex = new CodingExecutor(config(), localRunner());
		const one = { ...remaining(), calls: 1 };
		const r = await ex.round({ round: 1, kind: "code", prompt: "Implement.", sourceRevision: "1", remaining: one });
		// The first call was admitted under ordinal 1 and wrote the first file; Pi's follow-up call after the tool
		// result was refused by the allowance before any send, which ends the turn as a call failure.
		const sent = sidecar.requests.filter((q) => q.callId.startsWith("att_team:r1:coder:"));
		expect(sent.map((q) => q.callId)).toEqual(["att_team:r1:coder:1"]);
		expect(sidecar.totalSends()).toBe(1);
		expect(r.outcome?.calls).toBe(1);
		expect(r.outcome?.ended).toBe("call_failed");
		expect(r.outcome?.failureCode).toBe("BUDGET_EXHAUSTED");
		expect(r.outcome?.failure).toBe("allowance");
		expect(r.source?.files.map((f) => f.path)).toEqual(["README.md"]);
		expect(r.sessionUsage?.assistantMessages).toBe(2); // the answer and the refused turn's error message
	});

	it("a round tree the trusted side did not create (a planted link or a group-writable directory) refuses the round before any candidate", async () => {
		const { symlinkSync, chmodSync } = await import("node:fs");
		const elsewhere = mkdtempSync(path.join(tmpdir(), "planted-"));
		symlinkSync(elsewhere, path.join(workspace, "round"));
		let ran = 0;
		const runner = {
			run: async () => {
				ran++;
				return { exit: 0, stop: "exited" as const, descendantsStopped: 0, startedAt: "", endedAt: "" };
			},
		};
		const ex = new CodingExecutor(config(), runner);
		const spec = { round: 1, kind: "code" as const, prompt: "Implement.", sourceRevision: "1", remaining: remaining() };
		await expect(ex.round(spec)).rejects.toThrow(/not a real directory/);
		rmSync(path.join(workspace, "round"));
		mkdirSync(path.join(workspace, "round"));
		chmodSync(path.join(workspace, "round"), 0o777);
		await expect(new CodingExecutor(config(), runner).round(spec)).rejects.toThrow(/not a real directory/);
		expect(ran).toBe(0);
		rmSync(elsewhere, { recursive: true, force: true });
	});

	it("no two source writers: a second round while one runs is refused", async () => {
		sidecar.script = () => ({ text: ["slow"], behaviour: "hang" });
		const ex = new CodingExecutor(config(), localRunner());
		const first = ex.round({
			round: 1,
			kind: "code",
			prompt: "Implement.",
			sourceRevision: "1",
			remaining: remaining(),
		});
		// The coder is running once its first call is held open by the double (no fixed sleep).
		await vi.waitFor(() => expect(sidecar.inFlight).toBeGreaterThanOrEqual(1), { timeout: 30_000, interval: 50 });
		await expect(
			ex.round({ round: 2, kind: "code", prompt: "Implement.", sourceRevision: "1", remaining: remaining() }),
		).rejects.toBeInstanceOf(SourceWriterConflictError);
		sidecar.release();
		const r = await first;
		expect(r.sourceError?.code).toBe("CANDIDATE_BUILD_FAILED"); // an empty source: nothing was written
	});

	it("a refused call ends the round as call_failed with its code; links and escapes in the source are refused at the seal", async () => {
		sidecar.script = () => ({ behaviour: "refuse", refuseCode: "BUDGET_EXHAUSTED", refuseStatus: 429 });
		const ex = new CodingExecutor(config(), localRunner());
		mkdirSync(path.join(workspace, "w", "source"), { recursive: true });
		writeFileSync(path.join(workspace, "w", "source", "a.txt"), "a");
		const r = await ex.round({
			round: 1,
			kind: "code",
			prompt: "Implement.",
			sourceRevision: "1",
			remaining: remaining(),
		});
		expect(r.outcome?.ended).toBe("call_failed");
		expect(r.outcome?.failureCode).toBe("BUDGET_EXHAUSTED");
		expect(r.outcome?.failure).toBe("refused");
		expect(r.report.exit).toBe(1);
		expect(sidecar.totalSends()).toBe(0);
		const ex2 = new CodingExecutor({ ...config(), sealDir: mkdtempSync(path.join(tmpdir(), "seal2-")) }, localRunner());
		const { symlinkSync } = await import("node:fs");
		symlinkSync("/etc/hostname", path.join(workspace, "w", "source", "link.txt"));
		const r2 = await ex2.round({
			round: 1,
			kind: "code",
			prompt: "Implement.",
			sourceRevision: "1",
			remaining: remaining(),
		});
		expect(r2.sourceError?.code).toBe("PATH_ESCAPE");
		expect(existsSync(path.join(r2.sealedDir, "source", "link.txt"))).toBe(false);
	});

	it("a link at the source root or on the way to the session brings nothing from outside into the sealed artifacts", async () => {
		const { symlinkSync } = await import("node:fs");
		const outside = mkdtempSync(path.join(tmpdir(), "outside-"));
		writeFileSync(path.join(outside, "stolen.txt"), "outside content\n");
		mkdirSync(path.join(workspace, "w"), { recursive: true });
		// The source root replaced by a link to an outside directory (what a
		// candidate process of the same identity could plant between rounds).
		symlinkSync(outside, path.join(workspace, "w", "source"));
		heroScript(sidecar);
		const ex = new CodingExecutor(config(), localRunner());
		const r = await ex.round({
			round: 1,
			kind: "code",
			prompt: "Implement.",
			sourceRevision: "1",
			remaining: remaining(),
		});
		expect(r.source).toBeUndefined();
		expect(r.sourceError?.code).toBe("PATH_ESCAPE");
		expect(r.sourceError?.message).toMatch(/symbolic link/);
		expect(existsSync(path.join(r.sealedDir, "source"))).toBe(false);
		// The coder refused to work under the link as well: nothing of the fixture was written outside.
		expect(readdirSync(outside)).toEqual(["stolen.txt"]);
		expect(r.report.exit).not.toBe(0);
		expect(sidecar.totalSends()).toBe(0);
		// The trusted seal alone, with a hostile candidate in place of the coder:
		// it leaves a real source, a session directory that is a link to an
		// outside directory, and an outcome claiming a session file under it.
		const workspace2 = mkdtempSync(path.join(tmpdir(), "team-ws-"));
		const outsideSession = mkdtempSync(path.join(tmpdir(), "outside-session-"));
		writeFileSync(path.join(outsideSession, "s.jsonl"), '{"type":"session","id":"planted"}\n');
		const hostile = {
			run: async () => {
				const w = path.join(workspace2, "w");
				mkdirSync(path.join(w, "source", "src"), { recursive: true });
				writeFileSync(path.join(w, "source", "src", "index.ts"), "export {};\n");
				symlinkSync(outsideSession, path.join(w, "session"));
				mkdirSync(path.join(w, "rounds", "1"), { recursive: true });
				writeFileSync(
					path.join(w, "rounds", "1", "outcome.json"),
					JSON.stringify({
						schemaVersion: 1,
						round: 1,
						sessionFile: path.join(w, "session", "s.jsonl"),
						calls: 0,
						ended: "completed",
					}),
				);
				return { exit: 0, stop: "exited" as const, descendantsStopped: 0, startedAt: "", endedAt: "" };
			},
		};
		const ex2 = new CodingExecutor(
			{ ...config(), workspace: workspace2, sealDir: mkdtempSync(path.join(tmpdir(), "seal3-")) },
			hostile,
		);
		const r2 = await ex2.round({
			round: 1,
			kind: "code",
			prompt: "Implement.",
			sourceRevision: "1",
			remaining: remaining(),
		});
		expect(r2.source?.files.map((f) => f.path)).toEqual(["src/index.ts"]);
		expect(r2.outcome?.sessionFile).toContain("s.jsonl");
		expect(r2.sessionFile).toBeUndefined();
		expect(r2.sessionDigest).toBeUndefined();
		expect(r2.sessionError).toMatchObject({ code: "PATH_ESCAPE" });
		expect(existsSync(path.join(r2.sealedDir, "session.jsonl"))).toBe(false);
		// And the same hostile layout with the source root as a link: no source sealed, PATH_ESCAPE.
		const workspace3 = mkdtempSync(path.join(tmpdir(), "team-ws-"));
		const hostileRoot = {
			run: async () => {
				mkdirSync(path.join(workspace3, "w"), { recursive: true });
				symlinkSync(outside, path.join(workspace3, "w", "source"));
				return { exit: 0, stop: "exited" as const, descendantsStopped: 0, startedAt: "", endedAt: "" };
			},
		};
		const ex3 = new CodingExecutor(
			{ ...config(), workspace: workspace3, sealDir: mkdtempSync(path.join(tmpdir(), "seal4-")) },
			hostileRoot,
		);
		const r3 = await ex3.round({
			round: 1,
			kind: "code",
			prompt: "Implement.",
			sourceRevision: "1",
			remaining: remaining(),
		});
		expect(r3.source).toBeUndefined();
		expect(r3.sourceError).toMatchObject({ code: "PATH_ESCAPE" });
		expect(existsSync(path.join(r3.sealedDir, "source", "stolen.txt"))).toBe(false);
		for (const d of [workspace2, workspace3, outside, outsideSession]) rmSync(d, { recursive: true, force: true });
	});
});
