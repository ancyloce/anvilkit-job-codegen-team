// P2.4: the Retrieval specialist's port over the sidecar's Knowledge relay.
// DEC-045 B2: the relay double binds an abstract-namespace name, checks the
// coordinator's token and answers with the sidecar proof over the nonce.

import { randomBytes } from "node:crypto";
import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import {
	isNonce,
	peerNonceHeader,
	peerToken,
	peerTokenHeader,
	sidecarProof,
	sidecarProofHeader,
	socketPathOf,
} from "../src/adapters/peer.js";
import { SidecarRetrieval } from "../src/team/retrieval.js";

const token = peerToken(randomBytes(32).toString("hex"), "trusted");
let server: http.Server | undefined;
afterEach(() => {
	server?.close();
});

function relay(
	answer: (body: Record<string, unknown>) => [number, unknown],
	proof: "valid" | "missing" | "wrong" = "valid",
): Promise<{ socket: string; seen: Record<string, unknown>[] }> {
	const socket = `@anvilkit-test/retrieval-${process.pid}-${randomBytes(4).toString("hex")}/trusted`;
	const seen: Record<string, unknown>[] = [];
	server = http.createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on("data", (c: Buffer) => chunks.push(c));
		req.on("end", () => {
			const nonce = req.headers[peerNonceHeader];
			if (!isNonce(nonce) || req.headers[peerTokenHeader] !== token) {
				res.writeHead(403, { "content-type": "application/json" });
				res.end(JSON.stringify({ code: "PEER_TOKEN_MISMATCH" }));
				return;
			}
			const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
			seen.push({ path: req.url, ...body });
			const [status, out] = answer(body);
			const headers: Record<string, string> = { "content-type": "application/json" };
			if (proof === "valid") headers[sidecarProofHeader] = sidecarProof(token, nonce);
			if (proof === "wrong") headers[sidecarProofHeader] = sidecarProof(token, "0".repeat(32));
			res.writeHead(status, headers);
			res.end(JSON.stringify(out));
		});
	});
	return new Promise((resolve) => server?.listen(socketPathOf(socket), () => resolve({ socket, seen })));
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
		const r = new SidecarRetrieval(socket, token, {
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
		expect((await new SidecarRetrieval(socket, token).retrieve("q")).status).toBe("insufficient_evidence");
		expect(seen).toHaveLength(0);
		const denied = await new SidecarRetrieval(socket, token, {
			snapshotId: "denied",
			retrievalProfileId: "p",
		}).retrieve("q");
		expect(denied).toEqual({ status: "insufficient_evidence", reason: "knowledge relay answered FORBIDDEN" });
		const empty = await new SidecarRetrieval(socket, token, { snapshotId: "snap", retrievalProfileId: "p" }).retrieve(
			"q",
		);
		expect(empty.status).toBe("insufficient_evidence");
	});

	it("a wrong token is refused by the relay, and an answer without the sidecar's proof is never evidence", async () => {
		const items = [{ citation: { ordinal: "1", sourceId: "s", sourceRevision: "1", chunkId: "c" }, text: "t" }];
		const binding = { snapshotId: "snap", retrievalProfileId: "p" };
		const other = peerToken(randomBytes(32).toString("hex"), "trusted");
		// The relay refuses the token without a proof (§9), so the port can only
		// report an unproven answer: nothing of it is evidence.
		const refused = await relay(() => [200, { items }]);
		expect(await new SidecarRetrieval(refused.socket, other, binding).retrieve("q")).toEqual({
			status: "insufficient_evidence",
			reason: "the knowledge relay's answer carries no valid sidecar proof",
		});
		expect(refused.seen).toHaveLength(0);
		for (const proof of ["missing", "wrong"] as const) {
			const { socket } = await relay(() => [200, { items }], proof);
			const out = await new SidecarRetrieval(socket, token, binding).retrieve("q");
			expect(out).toEqual({
				status: "insufficient_evidence",
				reason: "the knowledge relay's answer carries no valid sidecar proof",
			});
			server?.close();
		}
	});
});
