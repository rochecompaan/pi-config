import crypto from "node:crypto";
import { existsSync } from "node:fs";
import { promises as fs } from "node:fs";
import path from "node:path";

const TODO_DIR_NAME = ".pi/todos";
const TODO_PATH_ENV = "PI_TODO_PATH";
const REVIEW_TODO_TAGS = ["review", "findings"] as const;
const DEFAULT_REVIEW_TODO_TITLE = "Review findings";
const MAX_TITLE_LENGTH = 96;

type NavigateTreeSummaryResult = {
	summaryEntry?: {
		summary?: unknown;
	};
};

export type ReviewTodoRecord = {
	id: string;
	title: string;
	tags: string[];
	status: string;
	created_at: string;
	body: string;
};

export type CreatedReviewTodo = ReviewTodoRecord & {
	path: string;
	displayId: string;
};

export type CreateReviewFindingsTodoOptions = {
	env?: NodeJS.ProcessEnv;
	now?: Date;
	idFactory?: () => string;
};

export function getReviewTodosDir(cwd: string, env: NodeJS.ProcessEnv = process.env): string {
	const overridePath = env[TODO_PATH_ENV];
	if (overridePath?.trim()) {
		return path.resolve(cwd, overridePath.trim());
	}

	return path.resolve(cwd, TODO_DIR_NAME);
}

function getSectionLines(markdown: string, expectedTitle: string): string[] {
	const lines = markdown.split(/\r?\n/);
	const sectionLines: string[] = [];
	let inSection = false;
	let sectionLevel = 0;

	for (const line of lines) {
		const heading = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
		if (heading) {
			const level = heading[1].length;
			const title = heading[2].trim().toLowerCase();
			if (inSection && level <= sectionLevel) {
				break;
			}
			if (title === expectedTitle.toLowerCase()) {
				inSection = true;
				sectionLevel = level;
				continue;
			}
		}

		if (inSection) {
			sectionLines.push(line);
		}
	}

	return sectionLines;
}

function normalizeScopeLine(line: string): string {
	return line
		.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "")
		.replace(/^\*\*(.+?)\*\*:\s*/, "$1: ")
		.replace(/^(?:what was reviewed|review scope|scope):\s*/i, "")
		.trim();
}

function truncateTitle(value: string): string {
	if (value.length <= MAX_TITLE_LENGTH) return value;
	return `${value.slice(0, MAX_TITLE_LENGTH - 1).trimEnd()}…`;
}

function extractReviewScope(summary: string): string | null {
	for (const line of getSectionLines(summary, "Review Scope")) {
		const normalized = normalizeScopeLine(line);
		if (!normalized || normalized === "(none)") continue;
		return normalized;
	}

	return null;
}

export function deriveReviewTodoTitle(summary: string): string {
	const scope = extractReviewScope(summary);
	if (!scope) return DEFAULT_REVIEW_TODO_TITLE;
	return `${DEFAULT_REVIEW_TODO_TITLE}: ${truncateTitle(scope)}`;
}

export function getReviewSummaryText(result: unknown): string | null {
	const summary = (result as NavigateTreeSummaryResult | null | undefined)?.summaryEntry?.summary;
	if (typeof summary !== "string") return null;
	const trimmed = summary.trim();
	return trimmed || null;
}

export function serializeReviewTodo(todo: ReviewTodoRecord): string {
	const frontMatter = JSON.stringify(
		{
			id: todo.id,
			title: todo.title,
			tags: todo.tags ?? [],
			status: todo.status,
			created_at: todo.created_at,
			assigned_to_session: undefined,
		},
		null,
		2,
	);

	const body = todo.body.replace(/^\n+/, "").replace(/\s+$/, "");
	if (!body) return `${frontMatter}\n`;
	return `${frontMatter}\n\n${body}\n`;
}

function getTodoPath(todosDir: string, id: string): string {
	return path.join(todosDir, `${id}.md`);
}

function createId(idFactory?: () => string): string {
	return idFactory ? idFactory() : crypto.randomBytes(4).toString("hex");
}

export async function createReviewFindingsTodo(
	cwd: string,
	summary: string,
	options: CreateReviewFindingsTodoOptions = {},
): Promise<CreatedReviewTodo> {
	const body = summary.trim();
	if (!body) {
		throw new Error("Cannot create review findings todo without summary text.");
	}

	const todosDir = getReviewTodosDir(cwd, options.env);
	await fs.mkdir(todosDir, { recursive: true });

	for (let attempt = 0; attempt < 10; attempt += 1) {
		const id = createId(options.idFactory);
		const filePath = getTodoPath(todosDir, id);
		if (existsSync(filePath)) continue;

		const todo: ReviewTodoRecord = {
			id,
			title: deriveReviewTodoTitle(body),
			tags: [...REVIEW_TODO_TAGS],
			status: "open",
			created_at: (options.now ?? new Date()).toISOString(),
			body,
		};

		try {
			await fs.writeFile(filePath, serializeReviewTodo(todo), { encoding: "utf8", flag: "wx" });
			return { ...todo, path: filePath, displayId: `TODO-${id}` };
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
			throw error;
		}
	}

	throw new Error("Failed to generate unique review findings todo id.");
}
