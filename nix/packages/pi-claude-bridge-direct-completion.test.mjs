import assert from "node:assert/strict";
import test from "node:test";
import { pathToFileURL } from "node:url";

const modulePath = process.env.BRIDGE_DIRECT_COMPLETION_MODULE;
if (!modulePath) {
	throw new Error("BRIDGE_DIRECT_COMPLETION_MODULE is required");
}

const { routeBridgeRequest } = await import(pathToFileURL(modulePath).href);

const transcriptContext = {
	messages: [
		{
			role: "system",
			content: "",
			toolsAdded: [{ name: "read", description: "", parameters: {} }],
		},
		{ role: "user", content: [{ type: "text", text: "Continue the task" }] },
	],
};

function branchHandlers() {
	return {
		isolated: () => "isolated",
		agent: () => "agent",
	};
}

test("Pi 0.87 transcript tools stay on the agent path", () => {
	assert.equal("tools" in transcriptContext, false);
	assert.equal(
		routeBridgeRequest(transcriptContext, branchHandlers(), {}),
		"agent",
	);
});

test("cacheRetention none routes a one-off completion to the isolated path", () => {
	assert.equal(
		routeBridgeRequest(
			transcriptContext,
			branchHandlers(),
			{ cacheRetention: "none" },
		),
		"isolated",
	);
});
