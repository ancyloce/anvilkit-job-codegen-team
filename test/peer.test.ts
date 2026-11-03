// DEC-045 B2: the peer binding as the team's clients implement it — the
// token and proof derivations against fixed vectors, the abstract-name
// translation, and the client's behaviour against the double: a wrong token
// is refused, an answer without the sidecar's proof is discarded (plain
// requests and the relay stream alike), and a correct proof lets the stream
// through.
import { randomBytes } from "node:crypto";
import http from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	assertPeerToken,
	hexEqual,
	isNonce,
	newNonce,
	peerHeaders,
	peerNonceHeader,
	peerToken,
	peerTokenHeader,
	proofValid,
	SidecarProofError,
	sidecarProof,
	sidecarProofHeader,
	socketPathOf,
} from "../src/adapters/peer.js";
import { SidecarClient, SidecarError } from "../src/adapters/sidecar.js";
import { FakeSidecar } from "./doubles.js";

const secret = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";
const trusted = "721070c393a813efd6b79b7b6f1b7596c8aea8266315cfa027d702837ca637a2";
const candidate = "43f1661832bf72edf5bd9a91fd2dc61265fc256106c4c79d3e054c8a049ff6eb";
const nonce = "0123456789abcdef0123456789abcdef";
const proof = "174c76dce92a46a98e48969afbde240f5c32cff18c27de8d0e8134c98e974740";

describe("peer binding derivations", () => {
	it("derives the tokens and the proof exactly as the protocol states (fixed vectors)", () => {
		expect(peerToken(secret, "trusted")).toBe(trusted);
		expect(peerToken(secret, "candidate")).toBe(candidate);
		expect(sidecarProof(trusted, nonce)).toBe(proof);
		expect(proofValid(trusted, nonce, proof)).toBe(true);
		expect(proofValid(candidate, nonce, proof)).toBe(false);
		expect(proofValid(trusted, newNonce(), proof)).toBe(false);
		expect(proofValid(trusted, nonce, undefined)).toBe(false);
		expect(proofValid(trusted, nonce, [proof])).toBe(false);
		expect(() => peerToken("not hex", "trusted")).toThrow(/64 lowercase hex/);
	});

	it("checks the shape of what a process is handed, and the nonce's shape", () => {
		expect(assertPeerToken(trusted, "x")).toBe(trusted);
		for (const bad of [undefined, "", trusted.toUpperCase(), trusted.slice(1), `${trusted}0`])
			expect(() => assertPeerToken(bad, "ANVILKIT_PEER_TOKEN")).toThrow(/ANVILKIT_PEER_TOKEN is not a peer token/);
		expect(isNonce(nonce)).toBe(true);
		expect(isNonce(newNonce())).toBe(true);
		expect(isNonce(nonce.toUpperCase())).toBe(false);
		expect(isNonce(nonce.slice(1))).toBe(false);
		expect(isNonce(undefined)).toBe(false);
		expect(newNonce()).not.toBe(newNonce());
		expect(hexEqual(trusted, trusted)).toBe(true);
		expect(hexEqual(trusted, candidate)).toBe(false);
		expect(hexEqual(trusted, "zz")).toBe(false);
	});

	it("sends the token and a fresh nonce under the protocol's header names", () => {
		const a = peerHeaders(trusted);
		const b = peerHeaders(trusted);
		expect(a.headers[peerTokenHeader]).toBe(trusted);
		expect(a.headers[peerNonceHeader]).toBe(a.nonce);
		expect(isNonce(a.nonce)).toBe(true);
		expect(a.nonce).not.toBe(b.nonce);
		expect(peerTokenHeader).toBe("anvilkit-peer-token");
		expect(peerNonceHeader).toBe("anvilkit-peer-nonce");
		expect(sidecarProofHeader).toBe("anvilkit-sidecar-proof");
	});

	it("maps the configuration form of an abstract name to Node's", () => {
		expect(socketPathOf("@anvilkit/trusted")).toBe("\0anvilkit/trusted");
		expect(socketPathOf("/run/x.sock")).toBe("/run/x.sock");
	});
});

describe("the client against the sidecar double", () => {
	let sidecar: FakeSidecar;
	beforeEach(async () => {
		sidecar = new FakeSidecar("peer");
		await sidecar.start();
	});
	afterEach(async () => {
		await sidecar.stop();
	});

	const relayRequest = (callId: string) => ({
		callId,
		routeId: "controlled-openai-v1",
		messages: [{ role: "user" as const, content: "hi" }],
		maxOutputTokens: 64,
		maxExposure: { currency: "USD", amount: "1000" },
	});

	it("the trusted token opens the trusted socket, the candidate's is refused there, and no token at all is refused", async () => {
		const ok = new SidecarClient(sidecar.trustedSocket, sidecar.trustedToken);
		expect((await ok.scope()).scope.attemptId).toBe("att_team");
		// The guard refuses the candidate's token (403 PEER_TOKEN_MISMATCH, no
		// proof); the refused client, unable to prove the sidecar answered,
		// discards the answer as a sidecar-identity failure (§9).
		const wrong = new SidecarClient(sidecar.trustedSocket, sidecar.candidateToken);
		await expect(wrong.scope()).rejects.toBeInstanceOf(SidecarProofError);
		await expect(wrong.relay(relayRequest("c1"))).rejects.toBeInstanceOf(SidecarProofError);
		expect(sidecar.requests).toHaveLength(0);
		expect(sidecar.refused).toEqual([
			{ kind: "trusted", code: "PEER_TOKEN_MISMATCH" },
			{ kind: "trusted", code: "PEER_TOKEN_MISMATCH" },
		]);
		expect(() => new SidecarClient(sidecar.trustedSocket, "")).toThrow(/not a peer token/);
		// A refusal at the guard carries no proof; the refused client sees the refusal, not a proof error.
		const raw = await new Promise<{ status: number; proof: unknown }>((resolve) => {
			http
				.request(
					{ socketPath: socketPathOf(sidecar.candidateSocket), method: "GET", path: "/v1/scope", headers: {} },
					(res) => {
						res.resume();
						resolve({ status: res.statusCode ?? 0, proof: res.headers[sidecarProofHeader] });
					},
				)
				.end();
		});
		expect(raw).toEqual({ status: 400, proof: undefined });
		expect(sidecar.refused.at(-1)).toEqual({ kind: "candidate", code: "PEER_NONCE_INVALID" });
	});

	it("the proof is verified on the relay stream and on refusals alike", async () => {
		const client = new SidecarClient(sidecar.trustedSocket, sidecar.trustedToken);
		const r = await client.relay(relayRequest("c2"));
		expect(r.final?.type).toBe("done");
		expect(sidecar.sends("c2")).toBe(1);
		// A refusal after the guard (a scripted budget refusal) still carries the proof: the client reports the refusal.
		sidecar.script = () => ({ behaviour: "refuse", refuseCode: "BUDGET_EXHAUSTED", refuseStatus: 403 });
		await expect(client.relay(relayRequest("c3"))).rejects.toBeInstanceOf(SidecarError);
		await expect(client.relay(relayRequest("c3"))).rejects.toMatchObject({ code: "BUDGET_EXHAUSTED" });
	});

	it("an answer without a valid proof is discarded whatever its status, plain and streamed", async () => {
		const token = peerToken(randomBytes(32).toString("hex"), "trusted");
		const name = `@anvilkit-test/noproof-${process.pid}-${randomBytes(4).toString("hex")}/trusted`;
		let mode: "none" | "wrong" | "stream" = "none";
		const impostor = http.createServer((req, res) => {
			req.resume();
			req.on("end", () => {
				const headers: Record<string, string> = { "content-type": "application/json" };
				if (mode === "wrong") headers[sidecarProofHeader] = sidecarProof(token, "f".repeat(32));
				if (mode === "stream") {
					res.writeHead(200, { "content-type": "text/event-stream" });
					res.end('id: 0\ndata: {"callId":"c4","sequence":"0","type":"admitted"}\n\n');
					return;
				}
				res.writeHead(200, headers);
				res.end(JSON.stringify({ scope: {}, launchId: "x", inputs: [] }));
			});
		});
		await new Promise<void>((resolve) => impostor.listen(socketPathOf(name), resolve));
		try {
			const client = new SidecarClient(name, token);
			await expect(client.scope()).rejects.toBeInstanceOf(SidecarProofError);
			mode = "wrong";
			await expect(client.scope()).rejects.toBeInstanceOf(SidecarProofError);
			await expect(client.acceptedStage()).rejects.toBeInstanceOf(SidecarProofError);
			mode = "stream";
			await expect(client.relay(relayRequest("c4"))).rejects.toBeInstanceOf(SidecarProofError);
		} finally {
			await new Promise<void>((resolve) => impostor.close(() => resolve()));
		}
	});
});
