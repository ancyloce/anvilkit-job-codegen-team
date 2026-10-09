// Pi's grep tool in the coder (P0.8 AC5, B-40/TEAM-02): ripgrep comes from
// the image's path, never from a download and never from the candidate's
// writable $HOME/.pi/agent/bin. The coder runs as a child process (as the
// supervisor runs it) under a preload that records every outbound
// connection attempt — fetch, TCP/TLS sockets, DNS lookups; the sidecar's
// AF_UNIX socket is the only transport allowed — and blocks it. A planted
// rg in $HOME/.pi/agent/bin records whether it ran. The SDK's own grep
// without the coder's pinned environment is the control: it executes the
// planted rg, and without any rg it attempts the download.
import { spawn, spawnSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RelayRequest } from "../src/adapters/sidecar.js";
import type { Allowance } from "../src/budget.js";
import { roundDirEnv } from "../src/coder.js";
import { type CandidateRunner, CodingExecutor } from "../src/executor.js";
import { FakeSidecar, type Matcher } from "./doubles.js";
import { packageRoot } from "./helpers.js";

/** Records (to ANVILKIT_TEST_NET_LOG) and refuses every outbound attempt other than an AF_UNIX path. */
const interceptor = `
import dns from "node:dns";
import net from "node:net";
import { appendFileSync } from "node:fs";
const record = (what) => appendFileSync(process.env.ANVILKIT_TEST_NET_LOG, what + "\\n");
globalThis.fetch = async (input) => {
	record("fetch " + String(input?.url ?? input));
	throw new TypeError("fetch failed: the test allows no network");
};
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
	const first = Array.isArray(args[0]) ? args[0][0] : args[0];
	const unix = (typeof first === "object" && first !== null && typeof first.path === "string") || (typeof first === "string" && !/^[0-9]+$/.test(first));
	if (unix) return connect.apply(this, args);
	record("connect " + JSON.stringify(first));
	process.nextTick(() => this.destroy(new Error("connect: the test allows no network")));
	return this;
};
for (const target of [dns, dns.promises]) {
	const lookup = target.lookup;
	target.lookup = function (host, ...rest) {
		record("lookup " + host);
		return lookup.call(this, "invalid.invalid", ...rest);
	};
}
`;

/** A stand-in for ripgrep: records that it ran and answers one match in --json form, naming itself in the line. */
function fakeRg(file: string, marker: string, label: string): void {
	writeFileSync(
		file,
		`#!/bin/sh
[ "$1" = "--version" ] && { echo "ripgrep 13.0.0"; exit 0; }
echo "$*" >> "${marker}"
for last; do :; done
printf '{"type":"match","data":{"path":{"text":"%s/src/needle.ts"},"lines":{"text":"${label}\\\\n"},"line_number":1,"absolute_offset":0,"submatches":[]}}\\n' "$last"
exit 0
`,
	);
	chmodSync(file, 0o755);
}

describe("Pi's grep tool runs the image's ripgrep, offline (AC5)", () => {
	let root: string;
	let sidecar: FakeSidecar;
	let home: string;
	let imageBin: string;
	// PATH holds only these directories: a host's own rg (a CI image may have one) is never found.
	let emptyBin: string;
	let netLog: string;
	const marks = () => ({ image: path.join(root, "image-rg.ran"), trap: path.join(root, "trap-rg.ran") });
	beforeEach(async () => {
		root = mkdtempSync(path.join(tmpdir(), "pi-offline-"));
		sidecar = new FakeSidecar("pi-offline");
		await sidecar.start();
		// The candidate's HOME with a planted rg where the SDK would put its download.
		home = path.join(root, "home");
		mkdirSync(path.join(home, ".pi", "agent", "bin"), { recursive: true });
		fakeRg(path.join(home, ".pi", "agent", "bin", "rg"), marks().trap, "TRAP: the candidate-writable bin directory");
		imageBin = path.join(root, "image-bin");
		mkdirSync(imageBin);
		fakeRg(path.join(imageBin, "rg"), marks().image, "matched by the image ripgrep");
		emptyBin = path.join(root, "empty-bin");
		mkdirSync(emptyBin);
		netLog = path.join(root, "net.log");
		writeFileSync(path.join(root, "intercept.mjs"), interceptor);
	});
	afterEach(async () => {
		await sidecar.stop();
		rmSync(root, { recursive: true, force: true });
	});

	/** The coder as a child process with the interceptor preloaded and the given PATH. */
	function coderRunner(pathEnv: string): CandidateRunner {
		const dist = path.join(packageRoot, "dist", "coder.js");
		const entry = existsSync(dist) ? [dist] : ["--import", "tsx", path.join(packageRoot, "src", "coder.ts")];
		return {
			run: (req) =>
				new Promise((resolve, reject) => {
					const startedAt = new Date().toISOString();
					const child = spawn(
						process.execPath,
						["--import", pathToFileURL(path.join(root, "intercept.mjs")).href, ...entry],
						{
							env: { PATH: pathEnv, HOME: home, [roundDirEnv]: req.roundDir, ANVILKIT_TEST_NET_LOG: netLog },
							stdio: ["ignore", "pipe", "pipe"],
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
							stop: "exited",
							descendantsStopped: 0,
							startedAt,
							endedAt: new Date().toISOString(),
						});
					});
				}),
		};
	}

	/** The coder's turn: write a file, grep for it, then say it is done. */
	const grepCoder: Matcher = (req: RelayRequest) => {
		const calls = req.messages.filter((m) => m.role === "assistant").length;
		if (calls === 0)
			return {
				text: ["Writing."],
				tools: [
					{
						id: "tc_w",
						name: "write",
						arguments: JSON.stringify({ path: "src/needle.ts", content: "export const needle = 1;\n" }),
					},
				],
			};
		if (calls === 1)
			return {
				text: ["Searching."],
				tools: [{ id: "tc_g", name: "grep", arguments: JSON.stringify({ pattern: "needle" }) }],
			};
		return { text: ["Done."] };
	};

	async function codeRound(pathEnv: string) {
		sidecar.script = grepCoder;
		const workspace = path.join(root, "workspace");
		mkdirSync(workspace);
		const remaining: Allowance = {
			calls: 10,
			exposure: { currency: "USD", amount: "200000" },
			aggregateCalls: 10,
			aggregateExposure: { currency: "USD", amount: "200000" },
		};
		const ex = new CodingExecutor(
			{
				workspace,
				sealDir: path.join(root, "seal"),
				candidateSocket: sidecar.candidateSocket,
				routeId: "controlled-openai-v1",
				callIdPrefix: "att_offline",
				model: { contextWindow: 128_000, maxTokens: 4096 },
				compaction: { enabled: false, reserveTokens: 8192, keepRecentTokens: 4096 },
				tools: ["read", "write", "edit", "ls", "grep", "find"],
				systemPrompt: "You are the coder. TRUSTED CODER PROMPT.",
				deadline: new Date(Date.now() + 5 * 60_000),
				limits: { maxCalls: 10, maxOutputTokens: 4096, exposurePerSend: { currency: "USD", amount: "20000" } },
				sourceLimits: { maxFiles: 64, maxFileBytes: 1 << 20, maxTotalBytes: 8 << 20 },
				maxSessionBytes: 8 << 20,
			},
			coderRunner(pathEnv),
		);
		const r = await ex.round({ round: 1, kind: "code", prompt: "Write and search.", sourceRevision: "1", remaining });
		expect(r.outcome?.ended).toBe("completed");
		// What the grep tool answered is the tool result the next call carries.
		const after = sidecar.requests.find((q) =>
			q.messages.some((m) => m.role === "assistant" && m.toolCalls?.some((t) => t.name === "grep")),
		);
		const toolResult = after?.messages.filter((m) => m.role === "tool").at(-1)?.content ?? "";
		return { toolResult: String(toolResult) };
	}

	const netAttempts = () => (existsSync(netLog) ? readFileSync(netLog, "utf8").trim().split("\n").filter(Boolean) : []);
	const binEntries = () => readdirSync(path.join(home, ".pi", "agent", "bin")).sort();

	it("the coder's grep runs the image's rg: no outbound attempt, the candidate's $HOME/.pi/agent/bin never consulted", async () => {
		const { toolResult } = await codeRound(imageBin);
		expect(toolResult).toContain("matched by the image ripgrep");
		expect(toolResult).not.toContain("TRAP");
		expect(existsSync(marks().image)).toBe(true);
		expect(existsSync(marks().trap)).toBe(false);
		expect(netAttempts()).toEqual([]);
		expect(binEntries()).toEqual(["rg"]);
	});

	it("without any ripgrep the coder's grep fails offline: nothing is downloaded, nothing is fetched", async () => {
		rmSync(path.join(home, ".pi"), { recursive: true });
		const { toolResult } = await codeRound(emptyBin);
		expect(toolResult).toMatch(/ripgrep \(rg\) is not available/);
		expect(netAttempts()).toEqual([]);
		expect(existsSync(path.join(home, ".pi"))).toBe(false);
	});

	it("control: the SDK's grep without the pinned environment runs the planted rg, and without one attempts the download", () => {
		const source = path.join(root, "source");
		mkdirSync(path.join(source, "src"), { recursive: true });
		writeFileSync(path.join(source, "src", "needle.ts"), "export const needle = 1;\n");
		const entry = pathToFileURL(
			path.join(packageRoot, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "index.js"),
		).href;
		const script = path.join(root, "control.mjs");
		writeFileSync(
			script,
			`const { createGrepToolDefinition } = await import(${JSON.stringify(entry)});
const tool = createGrepToolDefinition(${JSON.stringify(source)});
try {
	const r = await tool.execute("c1", { pattern: "needle" });
	console.log(JSON.stringify({ text: r.content[0].text }));
} catch (err) {
	console.log(JSON.stringify({ error: err.message }));
}
`,
		);
		const control = (pathEnv: string) => {
			const out = spawnSync(
				process.execPath,
				["--import", pathToFileURL(path.join(root, "intercept.mjs")).href, script],
				{ env: { PATH: pathEnv, HOME: home, ANVILKIT_TEST_NET_LOG: netLog }, encoding: "utf8", timeout: 60_000 },
			);
			return JSON.parse(out.stdout.trim().split("\n").at(-1) ?? "{}") as { text?: string; error?: string };
		};
		// The planted rg in the candidate's bin directory wins over the image's on PATH.
		expect(control(imageBin).text).toContain("TRAP");
		expect(existsSync(marks().trap)).toBe(true);
		// Without any rg the SDK reaches for the network (recorded and refused here).
		rmSync(path.join(home, ".pi"), { recursive: true });
		expect(control(emptyBin).error).toMatch(/could not be downloaded/);
		expect(netAttempts().some((a) => a.startsWith("fetch https://github.com/"))).toBe(true);
	});
});
