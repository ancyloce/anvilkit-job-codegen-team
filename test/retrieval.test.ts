// P2.4: the Retrieval specialist's port over the sidecar's Knowledge relay.

import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SidecarRetrieval } from "../src/team/retrieval.js";

let dir = "";
let server: http.Server | undefined;
afterEach(() => {
	server?.close();
	if (dir) rmSync(dir, { recursive: true, force: true });
});

function relay(
	answer: (body: Record<string, unknown>) => [number, unknown],
): Promise<{ socket: string; seen: Record<string, unknown>[] }> {
	dir = mkdtempSync(path.join(tmpdir(), "team-retrieval-"));
	const socket = path.join(dir, "trusted.sock");
	const seen: Record<string, unknown>[] = [];
	server = http.createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on("data", (c: Buffer) => chunks.push(c));
		req.on("end", () => {
			const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
			seen.push({ path: req.url, ...body });
			const [status, out] = answer(body);
			res.writeHead(status, { "content-type": "application/json" });
			res.end(JSON.stringify(out));
		});
	});
	return new Promise((resolve) => server?.listen(socket, () => resolve({ socket, seen })));
}

describe("SidecarRetrieval", () => {
	it("searches the brief's snapshot under the reviewed profile and returns cited evidence", async () => {
		const { socket, seen } = await relay(() => [
			200,
			{
				items: [
					{
						citation: { ordinal: "1", sourceId: "src-brand", sourceRevision: "2", chunkId: "chk_1" },
						text: "teal hero",
					},
				],
				noAnswer: false,
			},
		]);
		const r = new SidecarRetrieval(socket, {
			snapshotId: "snap_1",
			retrievalProfileId: "hybrid-bge-m3-dev-v1",
			maxContextItems: 4,
		});
		const out = await r.retrieve("which colours does the brand use?");
		expect(out).toEqual({ status: "evidence", evidence: [{ id: "chk_1", source: "src-brand@2", text: "teal hero" }] });
		expect(seen).toEqual([
			{
				path: "/v1/knowledge/searches",
				snapshotId: "snap_1",
				query: "which colours does the brand use?",
				maxContextItems: 4,
				retrievalProfileId: "hybrid-bge-m3-dev-v1",
			},
		]);
	});

	it("is insufficient evidence without a snapshot, on a refusal and on an empty answer; never a citation", async () => {
		const { socket, seen } = await relay((b) =>
			b.snapshotId === "denied" ? [403, { code: "FORBIDDEN" }] : [200, { items: [], noAnswer: true }],
		);
		expect((await new SidecarRetrieval(socket).retrieve("q")).status).toBe("insufficient_evidence");
		expect(seen).toHaveLength(0);
		const denied = await new SidecarRetrieval(socket, { snapshotId: "denied", retrievalProfileId: "p" }).retrieve("q");
		expect(denied).toEqual({ status: "insufficient_evidence", reason: "knowledge relay answered FORBIDDEN" });
		const empty = await new SidecarRetrieval(socket, { snapshotId: "snap", retrievalProfileId: "p" }).retrieve("q");
		expect(empty.status).toBe("insufficient_evidence");
	});
});
