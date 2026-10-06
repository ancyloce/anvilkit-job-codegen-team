// TeamRunner (DD-03 §1/§2, delivery.md P12-04): the LangGraph StateGraph of
// the fixed roles. Planner → Retrieval → Pi coder → (Code Reviewer ∥
// Security Reviewer) → independent validation → decide: seal, or one bounded
// repair round. This file is the wiring only: the nodes are in nodes/, the
// decisions in routing.ts, the state in state.ts. Parallelism, review and
// repair counts, recursion and the absolute deadline are the
// configuration's; LangGraph's checkpointer (SqliteSaver) records the state
// after every step for the joint stage, and nothing in a checkpoint grants a
// send: a resumed run reenters its calls under the same identities.
import { END, type LangGraphRunnableConfig, START, StateGraph } from "@langchain/langgraph";
import type { BaseCheckpointSaver } from "@langchain/langgraph-checkpoint";
import type { TeamConfig } from "../config.js";
import { nodeContext, type TeamDeps } from "./context.js";
import { codeNode } from "./nodes/coding.js";
import { planNode, retrieveNode, reviewerNode, reviewFanOutNode, reviewJoinNode } from "./nodes/specialists.js";
import { validateNode } from "./nodes/validation.js";
import { afterCode, afterValidation, fanOut, sealNode } from "./routing.js";
import { TeamState } from "./state.js";

/**
 * The graph's node set and wiring as one identity: it is part of the team
 * profile digest, so a stage sealed by another wiring never proves as this
 * one's (recovery refuses it rather than reading its checkpoint).
 */
export const teamGraphRevision = "anvilkit-codegen-team-graph/2";

export function buildTeamGraph(deps: TeamDeps, checkpointer: BaseCheckpointSaver) {
	const ctx = nodeContext(deps);
	return new StateGraph(TeamState)
		.addNode("planner", planNode(ctx))
		.addNode("retrieve", retrieveNode(ctx))
		.addNode("code", codeNode(ctx))
		.addNode("review", reviewFanOutNode(ctx))
		.addNode("code_reviewer", reviewerNode(ctx, "code_reviewer"))
		.addNode("security_reviewer", reviewerNode(ctx, "security_reviewer"))
		.addNode("review_join", reviewJoinNode())
		.addNode("validate", validateNode(ctx))
		.addNode("seal", sealNode(ctx))
		.addEdge(START, "planner")
		.addEdge("planner", "retrieve")
		.addEdge("retrieve", "code")
		.addConditionalEdges("code", afterCode(ctx), ["review", "validate", END])
		.addConditionalEdges("review", fanOut, ["code_reviewer", "security_reviewer"])
		.addEdge("code_reviewer", "review_join")
		.addEdge("security_reviewer", "review_join")
		.addEdge("review_join", "validate")
		.addConditionalEdges("validate", afterValidation(ctx), ["code", "seal"])
		.addEdge("seal", END)
		.compile({ checkpointer });
}

export const graphConfig = (config: TeamConfig, threadId: string): LangGraphRunnableConfig => ({
	configurable: { thread_id: threadId },
	recursionLimit: config.recursionLimit,
	maxConcurrency: config.parallelism,
});
