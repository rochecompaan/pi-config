import test from "node:test";
import assert from "node:assert/strict";
import {
	finishReviewLifecycle,
	startReviewLifecycle,
	type ReviewLifecycleStepResult,
} from "./review-model-lifecycle.ts";

const ok = (): ReviewLifecycleStepResult => ({ ok: true });
const fail = (error: string): ReviewLifecycleStepResult => ({ ok: false, error });

test("startReviewLifecycle orders navigation, model switch, activation, and dispatch", async () => {
	const events: string[] = [];
	const result = await startReviewLifecycle({
		navigateToReview: async () => {
			events.push("navigate");
			return ok();
		},
		switchReviewModel: async () => {
			events.push("switch");
			return ok();
		},
		rollbackToOrigin: async () => {
			events.push("rollback");
			return ok();
		},
		restoreOriginModel: async () => {
			events.push("restore");
			return ok();
		},
		activateAndDispatch: async () => {
			events.push("activate");
			events.push("dispatch");
		},
	});

	assert.deepEqual(result, { ok: true });
	assert.deepEqual(events, ["navigate", "switch", "activate", "dispatch"]);
});

test("startReviewLifecycle rolls back and restores without activation after switch failure", async () => {
	const events: string[] = [];
	const result = await startReviewLifecycle({
		navigateToReview: async () => {
			events.push("navigate");
			return ok();
		},
		switchReviewModel: async () => {
			events.push("switch");
			return fail("switch failed");
		},
		rollbackToOrigin: async () => {
			events.push("rollback");
			return fail("origin navigation failed");
		},
		restoreOriginModel: async () => {
			events.push("restore");
			return fail("restore failed");
		},
		activateAndDispatch: async () => {
			events.push("activate");
			events.push("dispatch");
		},
	});

	assert.deepEqual(result, {
		ok: false,
		error: "switch failed. Rollback problems: origin navigation failed; restore failed",
	});
	assert.deepEqual(events, ["navigate", "switch", "rollback", "restore"]);
});

test("finishReviewLifecycle restores after navigation before returning success", async () => {
	const events: string[] = [];
	const result = await finishReviewLifecycle({
		navigateToOrigin: async () => {
			events.push("navigate");
			return { ok: true, value: "summary" };
		},
		restoreOriginModel: async () => {
			events.push("restore");
			return ok();
		},
		rollbackToReview: async () => {
			events.push("rollback");
			return ok();
		},
	});

	assert.deepEqual(result, { ok: true, value: "summary" });
	assert.deepEqual(events, ["navigate", "restore"]);
});

test("finishReviewLifecycle reports successful rollback after restoration failure", async () => {
	const result = await finishReviewLifecycle({
		navigateToOrigin: async () => ({ ok: true, value: undefined }),
		restoreOriginModel: async () => fail("restore failed"),
		rollbackToReview: async () => ok(),
	});

	assert.deepEqual(result, {
		ok: false,
		error: "restore failed. Returned to the review branch; repair authentication and retry /end-review.",
	});
});

test("finishReviewLifecycle reports rollback failure after restoration failure", async () => {
	const events: string[] = [];
	const result = await finishReviewLifecycle({
		navigateToOrigin: async () => {
			events.push("navigate");
			return { ok: true, value: undefined };
		},
		restoreOriginModel: async () => {
			events.push("restore");
			return fail("restore failed");
		},
		rollbackToReview: async () => {
			events.push("rollback");
			return fail("review navigation failed");
		},
	});

	assert.deepEqual(result, {
		ok: false,
		error: "restore failed. Failed to return to the review branch: review navigation failed",
	});
	assert.deepEqual(events, ["navigate", "restore", "rollback"]);
});
