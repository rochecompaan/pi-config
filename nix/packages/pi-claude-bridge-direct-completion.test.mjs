import assert from "node:assert/strict";
import test from "node:test";
import { pathToFileURL } from "node:url";

const modulePath = process.env.BRIDGE_DIRECT_COMPLETION_MODULE;
if (!modulePath) {
	throw new Error("BRIDGE_DIRECT_COMPLETION_MODULE is required");
}

const { routeBridgeRequest } = await import(pathToFileURL(modulePath).href);

const HANDOFF_SYSTEM_PROMPT = `You are a context transfer assistant. Given a conversation history and the user's goal for a new thread, generate a focused prompt that:

1. Summarizes relevant context from the conversation (decisions made, approaches taken, key findings)
2. Lists any relevant files that were discussed or modified
3. Clearly states the next task based on the user's goal
4. Is self-contained - the new thread should be able to proceed without the old conversation

Format your response as a prompt the user can send to start the new thread. Be concise but include all necessary context. Do not include any preamble like "Here's the prompt" - just output the prompt itself.

Example output format:
## Context
We've been working on X. Key decisions:
- Decision 1
- Decision 2

Files involved:
- path/to/file1.ts
- path/to/file2.ts

## Task
[Clear description of what to do next based on user's goal]`;

const directContext = {
	systemPrompt: HANDOFF_SYSTEM_PROMPT,
	messages: [{ role: "user", content: "Prepare the handoff" }],
};

const simulatedCaptureError = "simulated prompt-capture failure";

test("omitted tools routes the exact handoff prompt to the isolated handler", () => {
	assert.equal(HANDOFF_SYSTEM_PROMPT.length, 883);
	assert.equal("tools" in directContext, false);

	let isolatedContext;
	let agentCalls = 0;
	const result = routeBridgeRequest(directContext, {
		isolated(context) {
			isolatedContext = context;
			return "isolated";
		},
		agent() {
			agentCalls += 1;
			throw new Error(simulatedCaptureError);
		},
	});

	assert.equal(result, "isolated");
	assert.strictEqual(isolatedContext, directContext);
	assert.equal(isolatedContext.systemPrompt, HANDOFF_SYSTEM_PROMPT);
	assert.equal(agentCalls, 0);
});

test("tools: [] stays on the agent handler and surfaces capture failure", () => {
	const agentContext = { ...directContext, tools: [] };
	let isolatedCalls = 0;
	let receivedAgentContext;

	assert.throws(
		() => routeBridgeRequest(agentContext, {
			isolated() {
				isolatedCalls += 1;
				return "isolated";
			},
			agent(context) {
				receivedAgentContext = context;
				throw new Error(simulatedCaptureError);
			},
		}),
		{ message: simulatedCaptureError },
	);

	assert.equal(isolatedCalls, 0);
	assert.strictEqual(receivedAgentContext, agentContext);
});
