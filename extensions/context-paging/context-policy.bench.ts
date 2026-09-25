import { performance } from "node:perf_hooks";
import { selectContext } from "./context-policy.ts";
import { projectActiveBranch } from "./history.ts";
import { HistoryNavigator } from "./navigator.ts";

const TURN_COUNT = 300;
const TOOL_OUTPUT_BYTES = 15 * 1024 * 1024;
const TOKEN_BUDGET = 128_000;

type BenchmarkMeasurement<T> = {
	milliseconds: number;
	value: T;
};

function measure<T>(operation: () => T): BenchmarkMeasurement<T> {
	const start = performance.now();
	const value = operation();
	return { milliseconds: performance.now() - start, value };
}

function outputForTurn(turn: number, length: number): string {
	const topic = ["cache", "parser", "history", "navigator", "paging", "needle"][turn % 6]!;
	const block = Array.from({ length: 8 }, (_, line) => {
		const record = `2026-02-25T00:00:${String(line).padStart(2, "0")}Z src/benchmark/turn-${String(turn).padStart(3, "0")}.ts:${String(line * 16).padStart(4, "0")} ${topic} event=read status=ok tokens=128`;
		return `${record.padEnd(127, " ")}\n`;
	}).join("");
	return block.repeat(Math.floor(length / block.length)) + block.slice(0, length % block.length);
}

function sessionHistory() {
	const entries: object[] = [];
	const outputBytesPerTurn = Math.floor(TOOL_OUTPUT_BYTES / TURN_COUNT);
	const finalOutputBytes = TOOL_OUTPUT_BYTES - outputBytesPerTurn * (TURN_COUNT - 1);
	for (let turn = 0; turn < TURN_COUNT; turn++) {
		const callId = `benchmark-call-${turn}`;
		const timestamp = turn * 3;
		entries.push(
			{
				type: "message",
				id: `benchmark-user-${turn}`,
				parentId: null,
				timestamp: new Date(timestamp).toISOString(),
				message: { role: "user", content: `Benchmark request ${turn}`, timestamp },
			},
			{
				type: "message",
				id: `benchmark-turn-${turn}`,
				parentId: null,
				timestamp: new Date(timestamp + 1).toISOString(),
				message: {
					role: "assistant",
					content: [{ type: "toolCall", id: callId, name: "read", arguments: { path: `src/${turn}.ts` } }],
					stopReason: "toolUse",
					timestamp: timestamp + 1,
				},
			},
			{
				type: "message",
				id: `benchmark-result-${turn}`,
				parentId: null,
				timestamp: new Date(timestamp + 2).toISOString(),
				message: {
					role: "toolResult",
					toolCallId: callId,
					toolName: "read",
					content: [{ type: "text", text: outputForTurn(turn, turn === TURN_COUNT - 1 ? finalOutputBytes : outputBytesPerTurn) }],
					isError: false,
					timestamp: timestamp + 2,
				},
			},
		);
	}
	entries.push({
		type: "message",
		id: "benchmark-active-request",
		parentId: null,
		timestamp: new Date(TURN_COUNT * 3).toISOString(),
		message: { role: "user", content: "Summarize the benchmark results.", timestamp: TURN_COUNT * 3 },
	});
	return entries;
}

function formatMilliseconds(milliseconds: number): string {
	return `${milliseconds.toFixed(2)} ms`;
}

const entries = sessionHistory();
const projection = measure(() => projectActiveBranch(entries as any));
const messages = entries.map((entry: any) => entry.message);
const selection = measure(() => selectContext({
	messages,
	systemPrompt: "You are a benchmark assistant.",
	activeTools: [{ name: "read", description: "Read a file", parameters: { type: "object" } }],
	modelContextWindow: TOKEN_BUDGET,
	tokenBudget: TOKEN_BUDGET,
	rawHistoryItems: projection.value,
}));
const rebuild = measure(() => new HistoryNavigator(projection.value));
const firstSearch = measure(() => rebuild.value.search({ query: "needle", limit: 5 }));
const cachedSearch = measure(() => rebuild.value.search({ query: "needle", limit: 5 }));

console.log(`workload: turns=${TURN_COUNT} entries=${entries.length} historyItems=${projection.value.length} toolOutputBytes=${TOOL_OUTPUT_BYTES}`);
console.log(`raw projection: ${formatMilliseconds(projection.milliseconds)}`);
console.log(`selectContext: ${formatMilliseconds(selection.milliseconds)} mode=${selection.value.mode} estimatedTokens=${selection.value.estimatedTokens} budgetTokens=${selection.value.budgetTokens} retainedMessages=${selection.value.messages.length}`);
console.log(`navigator rebuild: ${formatMilliseconds(rebuild.milliseconds)}`);
console.log(`navigator first search: ${formatMilliseconds(firstSearch.milliseconds)} results=${firstSearch.value.length}`);
console.log(`navigator cached search: ${formatMilliseconds(cachedSearch.milliseconds)} results=${cachedSearch.value.length}`);
