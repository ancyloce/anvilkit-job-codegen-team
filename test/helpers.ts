// Shared helpers of the team's tests: the coder as a child process of the
// test (what the Go supervisor does through its trampoline as UID 10001) —
// as the test's own user, or under the real UID split for the root tests —
// the coordinator as the supervisor runs it, and the relay script that makes
// Pi write the validator's fixed Hero component.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import type { RelayRequest } from "../src/adapters/sidecar.js";
import { roundDirEnv } from "../src/coder.js";
import { sha256 } from "../src/digest.js";
import type { CandidateRunner, CandidateRunReport } from "../src/executor.js";
import type { TeamResult } from "../src/protocol.js";
import { readTree } from "../src/source.js";
import type { FakeSidecar, Matcher, ScriptedCall } from "./doubles.js";

const here = path.dirname(fileURLToPath(import.meta.url));
export const packageRoot = path.resolve(here, "..");
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

/**
 * The root tests' gate (as the supervisor's privilege-drop tests): they run
 * the coder or a validator step as UID 10001 and need a root caller with
 * util-linux's unshare, mount and setpriv, and the built package (the
 * candidate executes dist/). The reason they cannot run, or "" when they
 * can; ANVILKIT_REQUIRE_ROOT_TESTS turns that reason into a failure.
 */
export function rootTestsUnavailable(): string {
	if (process.getuid?.() !== 0) return "needs a root caller (the candidate runs as UID 10001)";
	for (const tool of ["unshare", "mount", "setpriv"])
		if (spawnSync(tool, ["--version"], { stdio: "ignore" }).error) return `needs util-linux ${tool}`;
	if (!existsSync(path.join(packageRoot, "dist", "coder.js"))) return "needs the built package (pnpm run build)";
	return "";
}

export const rootTestsRequired = !!process.env.ANVILKIT_REQUIRE_ROOT_TESTS;

/**
 * The coder as the supervisor runs it, under the real UID split: UID/GID
 * 10001 through the reviewed setpriv drop (groups cleared, inheritable and
 * bounding sets emptied, no_new_privs), HOME its own workspace tree. The
 * test's package and Node lie under a private home the candidate identity
 * cannot traverse, so the child sees them through bind mounts at a
 * world-traversable stage in its own private mount namespace; nothing on
 * the host changes.
 */
export function uidRunner(o: { stage: string; home: string; uid?: number; gid?: number }): CandidateRunner {
	const team = path.join(o.stage, "team");
	const node = path.join(o.stage, "node");
	for (const d of [team, node]) mkdirSync(d, { recursive: true, mode: 0o755 });
	const script =
		'mount --bind "$1" "$2" && mount --bind "$3" "$4" && exec setpriv --reuid="$5" --regid="$6" --clear-groups --inh-caps=-all --bounding-set=-all --no-new-privs -- "$4/bin/node" "$2/dist/coder.js"';
	const args = [
		packageRoot,
		team,
		path.dirname(path.dirname(process.execPath)),
		node,
		String(o.uid ?? 10001),
		String(o.gid ?? 10001),
	];
	return {
		run: (req, signal) =>
			new Promise((resolve, reject) => {
				const startedAt = new Date().toISOString();
				const child = spawn(
					"unshare",
					["--mount", "--propagation", "private", "--", "/bin/sh", "-c", script, "sh", ...args],
					{
						env: { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: o.home, [roundDirEnv]: req.roundDir },
						stdio: ["ignore", "pipe", "pipe"],
						signal,
					},
				);
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

/** The supervisor's answer to a run-candidate request once the round ended. */
export function candidateEnded(req: Record<string, unknown>, report: CandidateRunReport): Record<string, unknown> {
	return {
		type: "candidate-ended",
		protocolVersion: 1,
		requestId: req.requestId,
		round: req.round,
		stop: report.stop,
		exit: report.exit,
		descendantsStopped: 0,
		startedAt: report.startedAt,
		endedAt: report.endedAt,
	};
}

/** The team configuration of the coordinator tests (no independent validator: the run is never certified). */
export const coordinatorTeamYaml = `
schemaVersion: 1
route: { id: controlled-openai-v1, contextWindow: 128000, maxTokens: 4096, exposurePerSend: "20000" }
currency: USD
parallelism: 2
recursionLimit: 64
deadlineMarginSeconds: 5
roles:
  planner: { maxCalls: 2, maxOutputTokens: 2048 }
  retrieval: { maxCalls: 2, maxOutputTokens: 1024 }
  coder: { maxCalls: 30, maxOutputTokens: 4096 }
  code_reviewer: { maxCalls: 2, maxOutputTokens: 2048 }
  security_reviewer: { maxCalls: 2, maxOutputTokens: 2048 }
aggregate: { maxCalls: 60, exposure: "1200000" }
reviews: { max: 2 }
repairs: { max: 2 }
compaction: { enabled: false, reserveTokens: 16384, keepRecentTokens: 8192 }
tools: [read, write, edit, ls, grep, find]
source: { maxFiles: 256, maxFileBytes: 1048576, maxTotalBytes: 16777216, maxSessionBytes: 8388608, maxReviewBytes: 262144 }
validation: { mode: none }
`;

export type SupervisorDouble = (
	req: Record<string, unknown>,
	ctx: { kill: () => void },
) => Promise<unknown | undefined>;

export interface CoordinatorRun {
	code: number | null;
	result: TeamResult;
	requests: Array<Record<string, unknown>>;
	log: string;
}

export interface CoordinatorLaunch {
	sidecar: FakeSidecar;
	/** The launch's scratch root: workspace/, verdict/, agent/ and team.yaml go under it. */
	root: string;
	supervisor: SupervisorDouble;
	teamYaml?: string;
	/** The frozen brief (the Hero brief at source revision 1 by default). */
	brief?: Record<string, unknown>;
	/** The launch envelope's component, when the launcher states one. */
	component?: Record<string, unknown>;
	/** Further launch inputs by name (a repair launch's stage, source and evidence). */
	inputs?: Record<string, Buffer>;
	/** The workspace's mode (an emptyDir is world-writable; 0o777 when the coder runs as UID 10001). */
	workspaceMode?: number;
}

/**
 * The coordinator as the Go supervisor runs it: a child process with the
 * process protocol on its stdio, here answered by a test double of the
 * supervisor (the real one is exercised by anvilkit-job-codegen-supervisor
 * and the parent's integration suite).
 */
export function runCoordinator(l: CoordinatorLaunch): Promise<CoordinatorRun> {
	const workspace = path.join(l.root, "workspace");
	const verdict = path.join(l.root, "verdict");
	const agent = path.join(l.root, "agent");
	const input = path.join(workspace, "input");
	for (const d of [workspace, verdict, input, path.join(agent, "team", "prompts")]) mkdirSync(d, { recursive: true });
	if (l.workspaceMode !== undefined) spawnSync("chmod", [l.workspaceMode.toString(8), workspace]);
	for (const f of [
		"tools.json",
		...["planner", "retrieval", "coder", "code_reviewer", "security_reviewer"].map((r) => `prompts/${r}.md`),
	])
		writeFileSync(path.join(agent, "team", f), readFileSync(path.join(packageRoot, "agent", "team", f)));
	const config = path.join(l.root, "team.yaml");
	writeFileSync(config, l.teamYaml ?? coordinatorTeamYaml);
	const inputs: Record<string, Buffer> = {
		brief: Buffer.from(JSON.stringify(l.brief ?? { schemaVersion: 1, ...heroBrief, sourceRevision: "1" })),
		...l.inputs,
	};
	for (const [name, bytes] of Object.entries(inputs)) writeFileSync(path.join(input, name), bytes);
	const scope = l.sidecar.scope as Record<string, string>;
	const envelope = {
		schemaVersion: 1,
		launchId: "launch_team",
		launchKey: scope.launchKey,
		operationId: scope.operationId,
		attemptId: scope.attemptId,
		profileId: scope.profileId,
		profileRevision: "2",
		jobKind: "codegen",
		executionEpoch: scope.executionEpoch,
		launchEpoch: "1",
		deadline: new Date(Date.now() + 10 * 60_000).toISOString().replace(/\.\d{3}Z$/, "Z"),
		...(l.component ? { component: l.component } : {}),
		inputs: Object.entries(inputs).map(([name, bytes]) => ({ name, digest: sha256(bytes) })),
	};
	const dist = path.join(packageRoot, "dist", "coordinator.js");
	const argv = existsSync(dist) ? [dist] : ["--import", "tsx", path.join(packageRoot, "src", "coordinator.ts")];
	const child = spawn(process.execPath, argv, {
		env: {
			PATH: process.env.PATH ?? "",
			HOME: verdict,
			ANVILKIT_TEAM_CONFIG: config,
			ANVILKIT_AGENT_DIR: agent,
			ANVILKIT_WORKSPACE: workspace,
			ANVILKIT_VERDICT_DIR: verdict,
			ANVILKIT_INPUT_DIR: input,
			ANVILKIT_TRUSTED_SOCKET: l.sidecar.trustedSocket,
			ANVILKIT_CANDIDATE_SOCKET: l.sidecar.candidateSocket,
			ANVILKIT_LAUNCH_ENVELOPE: JSON.stringify(envelope),
			ANVILKIT_OBSERVER_IDENTITY: "anvilkit-codegen-team",
			...(process.env.ANVILKIT_CODEGEN_TEAM_CONTRACTS_DIR
				? { ANVILKIT_CODEGEN_TEAM_CONTRACTS_DIR: process.env.ANVILKIT_CODEGEN_TEAM_CONTRACTS_DIR }
				: {}),
		},
		stdio: ["pipe", "pipe", "pipe"],
	});
	let log = "";
	child.stderr.on("data", (c: Buffer) => {
		log += c.toString();
	});
	const requests: Array<Record<string, unknown>> = [];
	const kill = () => child.kill("SIGTERM");
	createInterface({ input: child.stdout }).on("line", async (line) => {
		const req = JSON.parse(line) as Record<string, unknown>;
		requests.push(req);
		const answer = await l.supervisor(req, { kill });
		if (answer !== undefined && child.stdin.writable)
			child.stdin.write(`${typeof answer === "string" ? answer : JSON.stringify(answer)}\n`);
	});
	return new Promise((resolve) => {
		child.on("exit", (code) => {
			const result = JSON.parse(readFileSync(path.join(verdict, "team", "result.json"), "utf8")) as TeamResult;
			resolve({ code, result, requests, log });
		});
	});
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

/** The allocated identity of the fixed Hero component (the brief's, the validator fixture's declaration). */
export const heroIdentity = {
	componentId: "cmp_hero_fixed",
	puckType: "Hero",
	packageName: "@anvilkit/hero-fixed",
};

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
