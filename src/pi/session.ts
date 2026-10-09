// The Pi coding session as the team runs it (DD-03 §6, delivery.md P12-03):
// the fixed resources of resources.ts, the bounded file tools of
// boundary.ts, and the ControlledModelPort as the only transport of every
// model path the SDK has (turns, compaction, branch summaries; the
// module-level fallback is replaced by a refusal). The session is the same
// on a new session, a reload and after compaction because the loader
// returns the same fixed content every time and never reads the candidate
// workspace. Pi's agent directory is the image's root-owned one
// (environment.ts), never the source directory or the candidate's HOME:
// nothing Pi reads or runs from there is candidate-writable.
import "./environment.js";
import { type StreamFn, setDefaultStreamFn } from "@earendil-works/pi-agent-core";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import {
	type AgentSession,
	createAgentSession,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { type ControlledModel, controlledApi } from "../port/pi.js";
import type { Tool } from "./boundary.js";
import { piAgentDir } from "./environment.js";
import { FixedResourceLoader } from "./resources.js";

/**
 * The SDK admits a prompt only for a provider it considers configured
 * (ModelRuntime.hasConfiguredAuth): a registered provider whose api key
 * field is set. The route is registered as a provider of its own custom API
 * whose stream handler refuses, with a public marker in the api key field:
 * the marker is not a credential and no path presents it — the agent's
 * transport is the port (installed below), the SDK's request auth is
 * consulted only when the agent still runs the SDK's own streamSimple, and
 * the custom API has no vendor client. Provider keys stay in the Proxy.
 */
export const controlledProviderMarker = "anvilkit-controlled-relay";

export function registerControlledProvider(runtime: ModelRuntime, model: ControlledModel): void {
	runtime.registerProvider(model.provider, {
		api: controlledApi,
		baseUrl: model.baseUrl,
		apiKey: controlledProviderMarker,
		authHeader: false,
		streamSimple: () => {
			throw new Error(
				"the controlled provider has no transport of its own: every send goes through the ControlledModelPort",
			);
		},
		models: [
			{
				id: model.id,
				name: model.name,
				reasoning: model.reasoning,
				input: model.input,
				cost: model.cost,
				contextWindow: model.contextWindow,
				maxTokens: model.maxTokens,
			},
		],
	});
}

/** The module-level fallback of pi-agent-core refuses: no Agent constructed without a transport reaches a provider. */
export function refuseDefaultStreamFn(): void {
	setDefaultStreamFn(() => {
		throw new Error("no default model transport: every model send goes through the ControlledModelPort");
	});
}

export interface CoderSessionOptions {
	cwd: string;
	systemPrompt: string;
	model: ControlledModel;
	streamFn: StreamFn;
	tools: Tool[];
	/** The session file to continue (a sealed earlier round), or the directory a new session file is created in. */
	session: { file: string } | { dir: string };
	compaction: { enabled: boolean; reserveTokens: number; keepRecentTokens: number };
}

/**
 * Creates the coder's session: in-memory settings with retries off, an empty
 * credential store and no models file (nothing on disk is read), the fixed
 * loader, the file tools bound to the workspace, and the controlled stream
 * function installed on the agent (the SDK's default stream function is
 * replaced before the first prompt; compaction and branch summaries use the
 * agent's function too).
 */
export async function createCoderSession(o: CoderSessionOptions): Promise<AgentSession> {
	refuseDefaultStreamFn();
	const settingsManager = SettingsManager.inMemory({
		compaction: {
			enabled: o.compaction.enabled,
			reserveTokens: o.compaction.reserveTokens,
			keepRecentTokens: o.compaction.keepRecentTokens,
		},
		retry: { enabled: false, maxRetries: 0, provider: { maxRetries: 0 } },
		images: { blockImages: true, autoResize: false },
		quietStartup: true,
	});
	// modelsPath null: no models.json is read and the catalog store stays
	// in memory (the runtime keeps it under ~/.pi only beside a models
	// file), so the candidate's SDK reads and writes nothing outside the
	// workspace.
	const modelRuntime = await ModelRuntime.create({
		credentials: new InMemoryCredentialStore(),
		modelsPath: null,
		refreshOnCreate: false,
		allowModelNetwork: false,
	});
	registerControlledProvider(modelRuntime, o.model);
	const loader = new FixedResourceLoader(o.systemPrompt);
	await loader.reload();
	const sessionManager =
		"file" in o.session
			? SessionManager.open(o.session.file, undefined, o.cwd)
			: SessionManager.create(o.cwd, o.session.dir);
	const { session } = await createAgentSession({
		cwd: o.cwd,
		// Every agent-directory path the SDK would derive (auth, models,
		// settings, sessions, resources) is replaced above; the one it still
		// names is the image's root-owned directory, never the workspace.
		agentDir: piAgentDir,
		modelRuntime,
		model: o.model,
		thinkingLevel: "off",
		// Only these names are exposed, and under each of them the bounded
		// definition below, not the SDK's unbounded built-in of the same name.
		tools: o.tools.map((t) => t.name),
		customTools: o.tools,
		resourceLoader: loader,
		sessionManager,
		settingsManager,
	});
	// The agent's transport is the port; nothing else is ever installed.
	session.agent.streamFunction = o.streamFn;
	return session;
}
