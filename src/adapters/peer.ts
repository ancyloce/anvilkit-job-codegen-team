// The second peer binding of the access sidecar's sockets (DD-03 §5,
// DEC-045 B2) as every client of this package implements it: the sockets
// are abstract-namespace Unix sockets named with a leading "@" (a NUL byte
// on the wire), every request carries the socket's peer token and a fresh
// nonce, and every answer carries the sidecar's proof over that nonce, so
// a client knows it reached the sidecar and nothing else bound the name.
// The launch secret the tokens derive from never reaches this package: the
// coordinator and the coder receive their one token in the environment.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/** Request header: the token of the socket's role (64 lowercase hex). */
export const peerTokenHeader = "anvilkit-peer-token";
/** Request header: 16 fresh random bytes per request (32 lowercase hex). */
export const peerNonceHeader = "anvilkit-peer-nonce";
/** Response header: hex(HMAC-SHA256(key = the decoded token, "anvilkit/sidecar-proof/v1/" + nonce)). */
export const sidecarProofHeader = "anvilkit-sidecar-proof";

const tokenPattern = /^[0-9a-f]{64}$/;
const noncePattern = /^[0-9a-f]{32}$/;

export type PeerRole = "trusted" | "candidate";

/** A socket's token from the launch secret (the sidecar's side and the test double; a client is handed its token). */
export function peerToken(secretHex: string, role: PeerRole): string {
	if (!tokenPattern.test(secretHex)) throw new Error("launch secret is not 64 lowercase hex characters");
	return createHmac("sha256", Buffer.from(secretHex, "hex")).update(`anvilkit/peer-token/v1/${role}`).digest("hex");
}

/** Checks the shape of a token a process was handed (never its value). */
export function assertPeerToken(token: string | undefined, what: string): string {
	if (!token || !tokenPattern.test(token)) throw new Error(`${what} is not a peer token (64 lowercase hex characters)`);
	return token;
}

export function newNonce(): string {
	return randomBytes(16).toString("hex");
}

export function isNonce(nonce: unknown): nonce is string {
	return typeof nonce === "string" && noncePattern.test(nonce);
}

export function sidecarProof(token: string, nonce: string): string {
	return createHmac("sha256", Buffer.from(token, "hex")).update(`anvilkit/sidecar-proof/v1/${nonce}`).digest("hex");
}

/** Constant-time comparison of two hex strings of the same shape. */
export function hexEqual(a: string, b: string): boolean {
	if (a.length !== b.length || !/^[0-9a-f]*$/.test(a) || !/^[0-9a-f]*$/.test(b)) return false;
	return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
}

/** Whether a response header is the sidecar's proof over the nonce this client sent. */
export function proofValid(token: string, nonce: string, header: string | string[] | undefined): boolean {
	return typeof header === "string" && hexEqual(header, sidecarProof(token, nonce));
}

/** The headers of one request: a fresh nonce and the token. */
export function peerHeaders(token: string): { headers: Record<string, string>; nonce: string } {
	const nonce = newNonce();
	return { headers: { [peerTokenHeader]: token, [peerNonceHeader]: nonce }, nonce };
}

/** "@name" (configuration and environment form) to Node's "\0name" (the abstract namespace). */
export function socketPathOf(configured: string): string {
	return configured.startsWith("@") ? `\0${configured.slice(1)}` : configured;
}

/** The answer came from something that is not the sidecar (or the proof was dropped): the answer is discarded. */
export class SidecarProofError extends Error {
	constructor(
		readonly method: string,
		readonly route: string,
	) {
		super(`sidecar ${method} ${route}: the answer carries no valid sidecar proof`);
		this.name = "SidecarProofError";
	}
}
