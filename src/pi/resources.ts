// The Pi session's trusted resources (DD-03 §6): one explicit system
// prompt and nothing else. No AGENTS.md, .pi, SYSTEM.md, extension, skill,
// prompt template, theme or settings file of the workspace is ever read,
// on a new session, a reload or after compaction.
import { createExtensionRuntime, type ResourceLoader } from "@earendil-works/pi-coding-agent";

/**
 * FixedResourceLoader supplies exactly the trusted resources it was
 * constructed with: one system prompt, no extensions, skills, prompt
 * templates, themes or context files. reload() re-establishes the same
 * content; extendResources() (an extension's discovery hook) is refused.
 */
export class FixedResourceLoader implements ResourceLoader {
	private runtime = createExtensionRuntime();
	constructor(private readonly systemPrompt: string) {}
	getExtensions() {
		return { extensions: [], errors: [], runtime: this.runtime };
	}
	getSkills() {
		return { skills: [], diagnostics: [] };
	}
	getPrompts() {
		return { prompts: [], diagnostics: [] };
	}
	getThemes() {
		return { themes: [], diagnostics: [] };
	}
	getAgentsFiles() {
		return { agentsFiles: [] };
	}
	getSystemPrompt() {
		return this.systemPrompt;
	}
	getSystemPromptSource() {
		return undefined;
	}
	getAppendSystemPrompt() {
		return [];
	}
	getAppendSystemPromptSources() {
		return [];
	}
	extendResources() {
		throw new Error("the fixed resource loader accepts no discovered resources");
	}
	async reload() {
		this.runtime = createExtensionRuntime();
	}
}
