import test from "node:test";
import assert from "node:assert/strict";
import {
	finishQuickfixLifecycle,
	startQuickfixLifecycle,
	type QuickfixLifecycleStepResult,
} from "./lifecycle.ts";

const ok = (): QuickfixLifecycleStepResult => ({ ok: true });
const fail = (error: string, cancelled = false): QuickfixLifecycleStepResult =>
	cancelled ? { ok: false, error, cancelled: true } : { ok: false, error };

test("start orders navigation, activation, and dispatch", async () => {
	const events: string[] = [];
	const result = await startQuickfixLifecycle({
		navigateToBranch: async () => {
			events.push("navigate");
			return ok();
		},
		activateEntering: () => {
			events.push("activate");
		},
		dispatchInitialPrompt: async () => {
			events.push("dispatch");
		},
		recoverEditor: () => {
			events.push("recover");
		},
	});

	assert.deepEqual(result, { ok: true });
	assert.deepEqual(events, ["navigate", "activate", "dispatch"]);
});

test("start leaves inactive and undispatched after navigation failure", async () => {
	const events: string[] = [];
	const result = await startQuickfixLifecycle({
		navigateToBranch: async () => {
			events.push("navigate");
			return fail("branch navigation failed");
		},
		activateEntering: () => {
			events.push("activate");
		},
		dispatchInitialPrompt: async () => {
			events.push("dispatch");
		},
		recoverEditor: () => {
			events.push("recover");
		},
	});

	assert.deepEqual(result, { ok: false, error: "branch navigation failed" });
	assert.deepEqual(events, ["navigate"]);
});

test("start recovers the editor after dispatch failure while keeping active", async () => {
	const events: string[] = [];
	const result = await startQuickfixLifecycle({
		navigateToBranch: async () => {
			events.push("navigate");
			return ok();
		},
		activateEntering: () => {
			events.push("activate");
		},
		dispatchInitialPrompt: async () => {
			events.push("dispatch");
			throw new Error("submit failed");
		},
		recoverEditor: () => {
			events.push("recover");
		},
	});

	assert.deepEqual(result, {
		ok: false,
		error: "Failed to submit the quick-fix request: submit failed",
		recoverable: true,
	});
	assert.deepEqual(events, ["navigate", "activate", "dispatch", "recover"]);
});

test("finish waits, marks returning, navigates, then clears", async () => {
	const events: string[] = [];
	const result = await finishQuickfixLifecycle({
		waitForIdle: async () => {
			events.push("wait");
		},
		markReturning: () => {
			events.push("returning");
		},
		navigateToOrigin: async () => {
			events.push("navigate");
			return ok();
		},
		restoreActive: () => {
			events.push("restore");
		},
		clearActive: () => {
			events.push("clear");
		},
	});

	assert.deepEqual(result, { ok: true });
	assert.deepEqual(events, ["wait", "returning", "navigate", "clear"]);
});

test("finish leaves active state unchanged when waiting fails", async () => {
	const events: string[] = [];
	const result = await finishQuickfixLifecycle({
		waitForIdle: async () => {
			events.push("wait");
			throw new Error("still busy");
		},
		markReturning: () => {
			events.push("returning");
		},
		navigateToOrigin: async () => {
			events.push("navigate");
			return ok();
		},
		restoreActive: () => {
			events.push("restore");
		},
		clearActive: () => {
			events.push("clear");
		},
	});

	assert.deepEqual(result, { ok: false, error: "Failed to wait for idle state: still busy" });
	assert.deepEqual(events, ["wait"]);
});

test("finish restores active state and does not clear after navigation failure", async () => {
	const events: string[] = [];
	const result = await finishQuickfixLifecycle({
		waitForIdle: async () => {
			events.push("wait");
		},
		markReturning: () => {
			events.push("returning");
		},
		navigateToOrigin: async () => {
			events.push("navigate");
			return fail("origin navigation failed");
		},
		restoreActive: () => {
			events.push("restore");
		},
		clearActive: () => {
			events.push("clear");
		},
	});

	assert.deepEqual(result, { ok: false, error: "origin navigation failed" });
	assert.deepEqual(events, ["wait", "returning", "navigate", "restore"]);
});

test("finish returns cancelled navigation results", async () => {
	const events: string[] = [];
	const result = await finishQuickfixLifecycle({
		waitForIdle: async () => {
			events.push("wait");
		},
		markReturning: () => {
			events.push("returning");
		},
		navigateToOrigin: async () => {
			events.push("navigate");
			return fail("origin navigation cancelled", true);
		},
		restoreActive: () => {
			events.push("restore");
		},
		clearActive: () => {
			events.push("clear");
		},
	});

	assert.deepEqual(result, { ok: false, error: "origin navigation cancelled", cancelled: true });
	assert.deepEqual(events, ["wait", "returning", "navigate", "restore"]);
});
