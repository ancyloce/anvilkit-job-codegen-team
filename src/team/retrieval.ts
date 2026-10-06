// The retrieval port over the sidecar's trusted Knowledge relay (DD-03 §5,
// P16): in this build the sidecar answers 503 DEPENDENCY_UNAVAILABLE for
// every knowledge route, which the Retrieval specialist reports as
// insufficient evidence — never as a citation.
import http from "node:http";
import type { Evidence, RetrievalPort, RetrievalResult } from "./roles.js";

export class SidecarRetrieval implements RetrievalPort {
	constructor(
		private readonly socketPath: string,
		private readonly timeoutMs = 30_000,
	) {}

	retrieve(question: string): Promise<RetrievalResult> {
		const body = Buffer.from(JSON.stringify({ question }));
		return new Promise((resolve) => {
			const req = http.request(
				{
					socketPath: this.socketPath,
					method: "POST",
					path: "/v1/knowledge/retrieve",
					headers: { "content-type": "application/json", "content-length": body.length, connection: "close" },
					agent: false,
					timeout: this.timeoutMs,
				},
				(res) => {
					const chunks: Buffer[] = [];
					res.on("data", (c: Buffer) => chunks.push(c));
					res.on("end", () => {
						const text = Buffer.concat(chunks).toString("utf8");
						if (res.statusCode !== 200) {
							let code = `HTTP ${res.statusCode}`;
							try {
								code = (JSON.parse(text) as { code?: string }).code ?? code;
							} catch {
								// the status alone
							}
							resolve({ status: "insufficient_evidence", reason: `knowledge relay answered ${code}` });
							return;
						}
						try {
							const parsed = JSON.parse(text) as { evidence?: Evidence[] };
							const evidence = (parsed.evidence ?? []).filter(
								(e) => typeof e.id === "string" && typeof e.text === "string" && typeof e.source === "string",
							);
							if (evidence.length === 0)
								resolve({ status: "insufficient_evidence", reason: "the knowledge relay returned no evidence" });
							else resolve({ status: "evidence", evidence: evidence.slice(0, 32) });
						} catch {
							resolve({ status: "insufficient_evidence", reason: "the knowledge relay answered outside its contract" });
						}
					});
					res.on("error", (err) => resolve({ status: "insufficient_evidence", reason: err.message }));
				},
			);
			req.on("timeout", () => req.destroy(new Error("timeout")));
			req.on("error", (err) =>
				resolve({ status: "insufficient_evidence", reason: `knowledge relay unreachable: ${err.message}` }),
			);
			req.end(body);
		});
	}
}
