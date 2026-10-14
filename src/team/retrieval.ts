// The retrieval port over the sidecar's trusted Knowledge relay (DD-03 §5,
// P2.4): the Retrieval specialist's question is searched in the knowledge
// snapshot the brief names, under the reviewed retrieval profile, through
// POST /v1/knowledge/searches; the sidecar binds the operation's own scope
// (Knowledge decides readability for that actor and asks Control's
// commercial authorization). A brief without a snapshot, a refusal or an
// unreachable relay is insufficient evidence — never a citation.
import http from "node:http";
import type { Evidence, RetrievalPort, RetrievalResult } from "./roles.js";

export interface RetrievalBinding {
	/** The knowledge snapshot the brief names (absent: nothing to search). */
	snapshotId?: string;
	/** The reviewed retrieval profile of the environment (team.yaml knowledge). */
	retrievalProfileId?: string;
	maxContextItems?: number;
}

interface SearchItem {
	citation?: { ordinal?: string; sourceId?: string; sourceRevision?: string; chunkId?: string };
	text?: string;
}

export class SidecarRetrieval implements RetrievalPort {
	constructor(
		private readonly socketPath: string,
		private readonly binding: RetrievalBinding = {},
		private readonly timeoutMs = 30_000,
	) {}

	retrieve(question: string): Promise<RetrievalResult> {
		const { snapshotId, retrievalProfileId } = this.binding;
		if (!snapshotId || !retrievalProfileId)
			return Promise.resolve({
				status: "insufficient_evidence",
				reason: "no knowledge snapshot is bound to this brief (or no retrieval profile is reviewed here)",
			});
		const body = Buffer.from(
			JSON.stringify({
				snapshotId,
				query: question,
				maxContextItems: this.binding.maxContextItems ?? 8,
				retrievalProfileId,
			}),
		);
		return new Promise((resolve) => {
			const req = http.request(
				{
					socketPath: this.socketPath,
					method: "POST",
					path: "/v1/knowledge/searches",
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
							const parsed = JSON.parse(text) as { items?: SearchItem[]; noAnswer?: boolean };
							const evidence: Evidence[] = (parsed.items ?? [])
								.filter((i) => typeof i.text === "string" && typeof i.citation?.sourceId === "string")
								.map((i) => ({
									id: i.citation?.chunkId || `cite-${i.citation?.ordinal ?? "?"}`,
									source: `${i.citation?.sourceId}@${i.citation?.sourceRevision ?? "?"}`,
									text: i.text as string,
								}));
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
