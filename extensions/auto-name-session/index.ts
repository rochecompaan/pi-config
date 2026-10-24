import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { buildNamingPrompt, NAMING_SYSTEM_PROMPT, parseSessionName } from "./naming.ts";

const ENTRY_TYPE = "auto-name-session";

export default function registerAutoNameSession(pi: ExtensionAPI): void {
	let automaticName: string | undefined;
	let generation = 0;
	let controller: AbortController | undefined;
	let pending: Promise<void> = Promise.resolve();

	function cancel(): void {
		generation++;
		controller?.abort();
	}

	function restore(ctx: ExtensionContext): void {
		cancel();
		automaticName = undefined;
		// Names belong to the whole session, not one branch of its conversation.
		const entries = ctx.sessionManager.getEntries();
		for (let i = entries.length - 1; i >= 0; i--) {
			const entry = entries[i];
			if (entry.type !== "custom" || entry.customType !== ENTRY_TYPE) continue;
			const data = entry.data as { version?: unknown; name?: unknown } | undefined;
			if (data?.version === 1 && typeof data.name === "string") automaticName = data.name;
			break;
		}
	}

	pi.on("session_start", (_event, ctx) => restore(ctx));
	pi.on("session_tree", (_event, ctx) => restore(ctx));
	pi.on("before_agent_start", cancel);
	pi.on("session_shutdown", cancel);

	pi.on("agent_end", (event, ctx) => {
		const reply = event.messages.findLast(message => message.role === "assistant");
		if (!reply || reply.stopReason !== "stop") return;
		const currentName = pi.getSessionName();
		if (currentName && currentName !== automaticName) return;
		const model = ctx.modelRegistry.find("openai-codex", "gpt-6-luna");
		if (!model) return; // Never silently fall back to an expensive chat model.
		const prompt = buildNamingPrompt(currentName, ctx.sessionManager.getBranch());
		if (!prompt) return;

		cancel();
		const request = new AbortController();
		controller = request;
		const origin = {
			generation,
			sessionId: ctx.sessionManager.getSessionId(),
			leafId: ctx.sessionManager.getLeafId(),
		};
		const isCurrent = () => !request.signal.aborted && origin.generation === generation &&
			origin.sessionId === ctx.sessionManager.getSessionId() &&
			origin.leafId === ctx.sessionManager.getLeafId() && currentName === pi.getSessionName();

		// Wait for cancelled work to finish before starting another model request.
		pending = pending.then(async () => {
			if (!isCurrent()) return;
			const timeout = setTimeout(() => request.abort(), 10_000);
			timeout.unref();
			try {
				const response = await ctx.modelRegistry.complete(model, {
					systemPrompt: NAMING_SYSTEM_PROMPT,
					messages: [{ role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() }],
					tools: [],
				}, {
					reasoningEffort: "low",
					maxTokens: 256,
					cacheRetention: "none",
					sessionId: randomUUID(),
					signal: request.signal,
				});
				if (response.stopReason !== "stop" || !isCurrent()) return;
				const text = response.content.filter(block => block.type === "text").map(block => block.text).join("\n");
				const name = parseSessionName(text);
				if (!name || name === currentName) return;
				pi.setSessionName(name);
				pi.appendEntry(ENTRY_TYPE, { version: 1, name });
				automaticName = name;
			} finally {
				clearTimeout(timeout);
			}
		}).catch(() => {
			// Naming must never interrupt a conversation or expose provider errors.
		});

		// Print/JSON runs must finish saving the name before the process exits.
		if (ctx.mode !== "tui" && ctx.mode !== "rpc") return pending;
	});
}
