// Shared helpers of the team's tests: the coder as a child process of the
// test (what the Go supervisor does through its trampoline as UID 10001) and
// the relay script that makes Pi write the validator's fixed Hero component.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { RelayRequest } from "../src/adapters/sidecar.js";
import { roundDirEnv } from "../src/coder.js";
import type { CandidateRunner } from "../src/executor.js";
import { readTree } from "../src/source.js";
import type { FakeSidecar, Matcher, ScriptedCall } from "./doubles.js";

const here = path.dirname(fileURLToPath(import.meta.url));
/**
 * The independent validator's package (anvilkit-job-validator, built): in
 * the parent checkout beside this repository, elsewhere where
 * ANVILKIT_VALIDATOR_PACKAGE names it.
 */
export const validatorPackage =
	process.env.ANVILKIT_VALIDATOR_PACKAGE ?? path.resolve(here, "..", "..", "..", "validator");
export const heroFixture = path.join(validatorPackage, "fixtures", "component", "hero");

/** The coder as a child process of the test (same user): what the Go supervisor does through its trampoline as UID 10001. */
export function localRunner(): CandidateRunner {
	const src = path.resolve(here, "..", "src", "coder.ts");
	const dist = path.resolve(here, "..", "dist", "coder.js");
	const argv = existsSync(dist) ? [dist] : ["--import", "tsx", src];
	return {
		run: (req, signal) =>
			new Promise((resolve, reject) => {
				const startedAt = new Date().toISOString();
				const child = spawn(process.execPath, argv, {
					env: { PATH: process.env.PATH ?? "", HOME: req.roundDir, [roundDirEnv]: req.roundDir },
					stdio: ["ignore", "pipe", "pipe"],
					signal,
				});
				let log = "";
				child.stdout.on("data", (c: Buffer) => {
					log += c.toString();
				});
				child.stderr.on("data", (c: Buffer) => {
					log += c.toString();
				});
				child.on("error", reject);
				child.on("exit", (code, sig) => {
					if (process.env.ANVILKIT_TEST_VERBOSE) process.stderr.write(log);
					resolve({
						exit: code,
						signal: sig ?? undefined,
						stop: sig === "SIGTERM" ? "canceled" : "exited",
						descendantsStopped: 0,
						startedAt,
						endedAt: new Date().toISOString(),
					});
				});
			}),
	};
}

/** The coder's answers that write the fixed Hero component file by file, then say the source is complete. */
export function heroCoder(files?: Map<string, Buffer>): Matcher {
	const tree = files ?? readTree(heroFixture, { maxFiles: 100, maxFileBytes: 1 << 20, maxTotalBytes: 8 << 20 });
	const order = [...tree.keys()].sort();
	let n = 0;
	return (req: RelayRequest) => {
		const written = req.messages.filter(
			(m) => m.role === "assistant" && m.toolCalls?.some((t) => t.name === "write"),
		).length;
		const next = order[written];
		if (next !== undefined) {
			n++;
			return {
				text: [`Writing ${next}.`],
				tools: [
					{
						id: `tc_w_${n}`,
						name: "write",
						arguments: JSON.stringify({ path: next, content: tree.get(next)?.toString("utf8") }),
					},
				],
			};
		}
		return { text: ["The complete source is written."] };
	};
}

/** Scripts the countable relay so that Pi writes the fixed Hero component. */
export function heroScript(sidecar: FakeSidecar, files?: Map<string, Buffer>): void {
	sidecar.script = heroCoder(files);
}

export type TeamRole = "planner" | "retrieval" | "coder" | "code_reviewer" | "security_reviewer" | "unknown";

/** The role a relay request comes from, read from the trusted system prompt it carries. */
export function roleOf(req: RelayRequest): TeamRole {
	const system = req.messages.find((m) => m.role === "system")?.content ?? "";
	if (system.startsWith("You are the Planner")) return "planner";
	if (system.startsWith("You are the Retrieval")) return "retrieval";
	if (system.startsWith("You are the Code Reviewer")) return "code_reviewer";
	if (system.startsWith("You are the Security Reviewer")) return "security_reviewer";
	if (system.startsWith("You are the coder")) return "coder";
	return "unknown";
}

/** A relay script that answers each role as scripted; the coder writes the Hero component, the reviewers pass. */
export function teamScript(parts: Partial<Record<TeamRole, Matcher>> = {}): Matcher {
	const coder = parts.coder ?? heroCoder();
	const plan: Matcher =
		parts.planner ??
		(() => ({
			text: ["Planning."],
			tools: [{ id: "tc_plan", name: "submit_plan", arguments: JSON.stringify(heroPlan) }],
		}));
	const pass = (id: string): ScriptedCall => ({
		text: ["Reviewed."],
		tools: [{ id, name: "submit_findings", arguments: JSON.stringify({ verdict: "pass", findings: [] }) }],
	});
	return (req: RelayRequest) => {
		const role = roleOf(req);
		if (role === "coder") return coder(req);
		if (role === "planner") return plan(req);
		if (role === "code_reviewer") return (parts.code_reviewer ?? (() => pass("tc_cr")))(req);
		if (role === "security_reviewer") return (parts.security_reviewer ?? (() => pass("tc_sr")))(req);
		if (role === "retrieval") return (parts.retrieval ?? (() => ({ text: ["?"] })))(req);
		return { text: ["?"] };
	};
}

export const heroBrief = {
	componentId: "cmp_hero_fixed",
	puckType: "Hero",
	packageName: "@anvilkit/hero-fixed",
	version: "1.0.0",
	requirements:
		"A hero section with a title, a subtitle, a left/center alignment and a call-to-action button that counts its clicks.",
};

export const heroPlan = {
	componentId: "cmp_hero_fixed",
	puckType: "Hero",
	packageName: "@anvilkit/hero-fixed",
	version: "1.0.0",
	steps: [
		{
			id: "declare",
			title: "Declaration and package",
			files: ["component.json", "package.json", "pnpm-lock.yaml", "README.md"],
			detail:
				"Declare the entry, the stylesheet, the mark resource, the usage file and the four editable fields; exact react and @puckeditor/core versions.",
		},
		{
			id: "implement",
			title: "Implement the Hero",
			files: ["src/index.tsx", "src/hero.tsx"],
			detail: "Export config, default and Hero; a button counting clicks in data-clicks.",
		},
		{
			id: "style",
			title: "Stylesheet and resource",
			files: ["styles/hero.css", "assets/mark.svg"],
			detail: "The hero layout and the mark.",
		},
	],
};
