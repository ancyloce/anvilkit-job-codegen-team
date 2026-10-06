// The reviewed tools of the team (openapi/model-proxy.yaml ToolDefinition):
// the structured outputs of the specialists (submit_plan, submit_findings)
// and the file tools of the Pi coder. The Model Proxy serves a tool only when
// the route's configuration carries the same name and schema (canonical
// digest); agent/team/tools.json is the reviewed list the Proxy's route
// configuration embeds, generated from here and checked for drift.
import { canonicalDigest } from "../digest.js";
import { coderToolNames, coderTools } from "../pi/boundary.js";

export interface ReviewedTool {
	name: string;
	description: string;
	inputSchema: Record<string, unknown>;
}

export const submitPlanSchema: Record<string, unknown> = {
	type: "object",
	additionalProperties: false,
	required: ["componentId", "puckType", "packageName", "version", "steps"],
	properties: {
		componentId: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$" },
		puckType: { type: "string", pattern: "^[A-Z][A-Za-z0-9]{0,63}$" },
		packageName: { type: "string", maxLength: 214 },
		version: { type: "string", pattern: "^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)$" },
		steps: {
			type: "array",
			minItems: 1,
			maxItems: 12,
			items: {
				type: "object",
				additionalProperties: false,
				required: ["id", "title", "files", "detail"],
				properties: {
					id: { type: "string", pattern: "^[a-z0-9-]{1,32}$" },
					title: { type: "string", minLength: 1, maxLength: 200 },
					files: { type: "array", maxItems: 32, items: { type: "string", minLength: 1, maxLength: 512 } },
					detail: { type: "string", minLength: 1, maxLength: 4000 },
				},
			},
		},
	},
};

export const submitFindingsSchema: Record<string, unknown> = {
	type: "object",
	additionalProperties: false,
	required: ["verdict", "findings"],
	properties: {
		verdict: { enum: ["pass", "repair"] },
		findings: {
			type: "array",
			maxItems: 64,
			items: {
				type: "object",
				additionalProperties: false,
				required: ["id", "severity", "file", "summary", "remediation"],
				properties: {
					id: { type: "string", pattern: "^[A-Za-z0-9-]{1,32}$" },
					severity: { enum: ["blocker", "major", "minor"] },
					file: { type: "string", minLength: 1, maxLength: 512 },
					line: { type: "integer", minimum: 1 },
					summary: { type: "string", minLength: 1, maxLength: 1000 },
					remediation: { type: "string", minLength: 1, maxLength: 2000 },
				},
			},
		},
	},
};

export const submitRetrievalSchema: Record<string, unknown> = {
	type: "object",
	additionalProperties: false,
	required: ["answer", "citations"],
	properties: {
		answer: { type: "string", minLength: 1, maxLength: 8000 },
		citations: { type: "array", maxItems: 32, items: { type: "string", minLength: 1, maxLength: 128 } },
	},
};

export const specialistTools: ReviewedTool[] = [
	{
		name: "submit_plan",
		description: "Submits the finite structured plan of the component (the Planner's only output).",
		inputSchema: submitPlanSchema,
	},
	{
		name: "submit_findings",
		description: "Submits review findings with severities, file references and remediations, and the review verdict.",
		inputSchema: submitFindingsSchema,
	},
	{
		name: "submit_retrieval",
		description: "Submits the answer to a retrieval question with the ids of the returned evidence it cites.",
		inputSchema: submitRetrievalSchema,
	},
];

/** Every reviewed tool: the specialists' and the coder's, with the exact schemas the SDK builds. */
export function reviewedTools(): ReviewedTool[] {
	const coder = coderTools("/workspace/w/source", coderToolNames).map((t) => ({
		name: t.name,
		description: t.description.length > 4096 ? t.description.slice(0, 4096) : t.description,
		inputSchema: JSON.parse(JSON.stringify(t.parameters)) as Record<string, unknown>,
	}));
	return [...specialistTools, ...coder];
}

export function toolDefinition(t: ReviewedTool) {
	return { name: t.name, description: t.description, inputSchemaDigest: canonicalDigest(t.inputSchema) };
}

/** The reviewed list as the Proxy's route configuration states it (tools: [{name, description, input_schema}]). */
export function reviewedToolsDocument(): {
	schemaVersion: 1;
	tools: Array<{ name: string; description: string; input_schema: Record<string, unknown>; inputSchemaDigest: string }>;
} {
	return {
		schemaVersion: 1,
		tools: reviewedTools().map((t) => ({
			name: t.name,
			description: t.description,
			input_schema: t.inputSchema,
			inputSchemaDigest: canonicalDigest(t.inputSchema),
		})),
	};
}
