import test from "node:test";
import assert from "node:assert/strict";
import type { SelectItem } from "@earendil-works/pi-tui";
import type { CopyItem } from "./copy-items.ts";
import { buildSearchIndex, normalizeForSearch, rankedFilterItems } from "./search.ts";

const copyItems: CopyItem[] = [
	{
		id: "message",
		kind: "message",
		content: "Release summary for Slack",
		messageId: "m1",
		sourceLabel: "10:00:00",
		sourcePosition: -1,
	},
	{
		id: "pipe",
		kind: "pipe-message",
		content: "Deployment complete",
		messageId: "m1",
		sourceLabel: "10:00:00",
		sourcePosition: 2,
	},
	{
		id: "code",
		kind: "code",
		content: "npm test",
		messageId: "m2",
		sourceLabel: "09:00:00",
		sourcePosition: 4,
		language: "sh",
	},
];
const selectItems: SelectItem[] = copyItems.map((item) => ({ value: item.id, label: item.id }));
const index = buildSearchIndex(copyItems, selectItems);

test("normalizes punctuation and case", () => {
	assert.equal(normalizeForSearch("Pipe-Message: DEPLOYMENT"), "pipe message deployment");
});

test("searches content, type label, time, and language", () => {
	for (const [query, expected] of [
		["slack", "message"],
		["pipe message", "pipe"],
		["09 00", "code"],
		["sh", "code"],
	] as const) {
		assert.equal(rankedFilterItems(query, selectItems, index)[0]?.value, expected);
	}
});

test("keeps source order when scores match and returns all items for an empty filter", () => {
	assert.deepEqual(rankedFilterItems("", selectItems, index), selectItems);
	assert.deepEqual(
		rankedFilterItems("10 00", selectItems, index).map((item) => item.value),
		["message", "pipe"],
	);
});
