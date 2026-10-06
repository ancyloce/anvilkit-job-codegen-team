// Digests and the canonical JSON form the platform shares: sha256 over exact
// bytes, and the canonical (members sorted, no whitespace) JSON text whose
// digest names a reviewed tool schema on the Model Proxy (its
// toolSchemaDigest) and a request on the sidecar relay.
import { createHash } from "node:crypto";

export type Digest = `sha256:${string}`;

export function sha256(data: Buffer | string): Digest {
	return `sha256:${createHash("sha256").update(data).digest("hex")}`;
}

/** Canonical JSON: object members sorted, arrays in order, no whitespace. */
export function canonicalJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	if (value !== null && typeof value === "object") {
		const record = value as Record<string, unknown>;
		const keys = Object.keys(record).sort();
		return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(record[k])}`).join(",")}}`;
	}
	return JSON.stringify(value);
}

export function canonicalDigest(value: unknown): Digest {
	return sha256(canonicalJson(value));
}

/** A decimal sequence string of the contracts (no sign, no leading zero). */
export function sequence(n: number | bigint): string {
	if (typeof n === "number" && (!Number.isSafeInteger(n) || n < 0)) throw new Error(`not a sequence: ${n}`);
	if (typeof n === "bigint" && n < 0n) throw new Error(`not a sequence: ${n}`);
	return n.toString();
}
