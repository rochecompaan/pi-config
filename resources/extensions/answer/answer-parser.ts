export interface ExtractedQuestion {
	question: string;
	context?: string;
}

export interface ExtractionResult {
	questions: ExtractedQuestion[];
}

export function extractQuestionsFromText(text: string): ExtractedQuestion[] {
	return extractQuestionsFromPlainText(text.trim());
}

export function parseExtractionResult(text: string): ExtractionResult | null {
	for (const candidate of collectJsonCandidates(text)) {
		const parsed = parseJsonCandidate(candidate);
		const normalized = normalizeExtractionResult(parsed);
		if (normalized) {
			return normalized;
		}
	}

	const fallback = parsePlainTextExtractionResult(text);
	if (fallback) {
		return fallback;
	}

	return null;
}

function collectJsonCandidates(text: string): string[] {
	const candidates = new Set<string>();
	const trimmed = text.trim();
	if (trimmed) {
		candidates.add(trimmed);
	}

	for (const match of text.matchAll(/```(?:json|javascript|js)?\s*([\s\S]*?)```/gi)) {
		const block = match[1]?.trim();
		if (block) {
			candidates.add(block);
		}
	}

	for (const snippet of extractBalancedJsonSnippets(text)) {
		candidates.add(snippet);
	}

	return [...candidates];
}

function extractBalancedJsonSnippets(text: string): string[] {
	const snippets: string[] = [];
	for (let index = 0; index < text.length; index++) {
		const start = text[index];
		if (start !== "{" && start !== "[") {
			continue;
		}
		const snippet = readBalancedJson(text, index);
		if (snippet) {
			snippets.push(snippet);
			index += snippet.length - 1;
		}
	}
	return snippets;
}

function readBalancedJson(text: string, startIndex: number): string | null {
	const start = text[startIndex];
	const end = start === "{" ? "}" : "]";
	let depth = 0;
	let inString = false;
	let escaped = false;

	for (let index = startIndex; index < text.length; index++) {
		const char = text[index];

		if (inString) {
			if (escaped) {
				escaped = false;
				continue;
			}
			if (char === "\\") {
				escaped = true;
				continue;
			}
			if (char === '"') {
				inString = false;
			}
			continue;
		}

		if (char === '"') {
			inString = true;
			continue;
		}
		if (char === start) {
			depth += 1;
			continue;
		}
		if (char === end) {
			depth -= 1;
			if (depth === 0) {
				return text.slice(startIndex, index + 1).trim();
			}
		}
	}

	return null;
}

function parseJsonCandidate(candidate: string): unknown {
	try {
		return JSON.parse(candidate);
	} catch {
		const normalizedQuotes = candidate.replace(/[“”]/g, '"');
		if (normalizedQuotes !== candidate) {
			try {
				return JSON.parse(normalizedQuotes);
			} catch {
				return null;
			}
		}
		return null;
	}
}

function normalizeExtractionResult(value: unknown): ExtractionResult | null {
	if (Array.isArray(value)) {
		const questions = normalizeQuestions(value);
		return questions ? { questions } : null;
	}

	if (!value || typeof value !== "object") {
		return null;
	}

	const record = value as Record<string, unknown>;
	if (Array.isArray(record.questions)) {
		const questions = normalizeQuestions(record.questions);
		return questions ? { questions } : null;
	}

	if (record.questions && typeof record.questions === "object") {
		const nested = record.questions as Record<string, unknown>;
		if (Array.isArray(nested.items)) {
			const questions = normalizeQuestions(nested.items);
			return questions ? { questions } : null;
		}
	}

	if (Array.isArray(record.items)) {
		const questions = normalizeQuestions(record.items);
		return questions ? { questions } : null;
	}

	if (typeof record.question === "string") {
		const question = record.question.trim();
		if (!question) {
			return null;
		}
		const result: ExtractedQuestion = { question };
		if (typeof record.context === "string" && record.context.trim()) {
			result.context = record.context.trim();
		}
		return { questions: [result] };
	}

	return null;
}

function normalizeQuestions(value: unknown[]): ExtractedQuestion[] | null {
	const normalized: ExtractedQuestion[] = [];
	for (const item of value) {
		const question = normalizeQuestion(item);
		if (question) {
			normalized.push(question);
		}
	}

	if (normalized.length === 0 && value.length > 0) {
		return null;
	}

	return normalized;
}

function normalizeQuestion(value: unknown): ExtractedQuestion | null {
	if (typeof value === "string") {
		const question = value.trim();
		return question ? { question } : null;
	}

	if (!value || typeof value !== "object") {
		return null;
	}

	const record = value as Record<string, unknown>;
	if (typeof record.question !== "string") {
		return null;
	}

	const question = record.question.trim();
	if (!question) {
		return null;
	}

	const normalized: ExtractedQuestion = { question };
	if (typeof record.context === "string") {
		const context = record.context.trim();
		if (context) {
			normalized.context = context;
		}
	}
	return normalized;
}

function parsePlainTextExtractionResult(text: string): ExtractionResult | null {
	const trimmed = text.trim();
	if (!trimmed) {
		return { questions: [] };
	}

	if (looksLikeNoQuestions(trimmed)) {
		return { questions: [] };
	}

	const questions = extractQuestionsFromPlainText(trimmed);
	if (questions.length > 0) {
		return { questions };
	}

	return null;
}

function looksLikeNoQuestions(text: string): boolean {
	const normalized = text
		.toLowerCase()
		.replace(/[`'"*_]/g, "")
		.replace(/\s+/g, " ")
		.trim();

	return [
		"no questions",
		"no question",
		"there are no questions",
		"there is no question",
		"no questions found",
		"no question found",
		"no user input needed",
		"no user input required",
		"none",
		"n/a",
	].some((phrase) => normalized === phrase || normalized.startsWith(`${phrase}.`) || normalized.startsWith(`${phrase}:`));
}

function extractQuestionsFromPlainText(text: string): ExtractedQuestion[] {
	const questions: ExtractedQuestion[] = [];
	const seen = new Set<string>();

	for (const line of text.split(/\r?\n/)) {
		const cleaned = cleanCandidateLine(line);
		if (!cleaned || !cleaned.includes("?")) {
			continue;
		}

		for (const question of extractQuestionSentences(cleaned)) {
			const normalized = question.replace(/\s+/g, " ").trim();
			if (!normalized || seen.has(normalized)) {
				continue;
			}
			seen.add(normalized);
			questions.push({ question: normalized });
		}
	}

	if (questions.length > 0) {
		return questions;
	}

	for (const question of extractQuestionSentences(text)) {
		const normalized = question.replace(/\s+/g, " ").trim();
		if (!normalized || seen.has(normalized)) {
			continue;
		}
		seen.add(normalized);
		questions.push({ question: normalized });
	}

	return questions;
}

function cleanCandidateLine(line: string): string {
	return line
		.trim()
		.replace(/^[-*•]\s+/, "")
		.replace(/^\d+[.)]\s+/, "")
		.replace(/^questions?:\s*/i, "")
		.replace(/^question:\s*/i, "")
		.trim();
}

function extractQuestionSentences(text: string): string[] {
	const matches = text.match(/[^?\n]*\?/g) ?? [];
	return matches
		.map((match) => cleanQuestionSentence(match))
		.filter((match): match is string => Boolean(match));
}

function cleanQuestionSentence(text: string): string | null {
	const cleaned = text
		.replace(/^[\s\-–—*•\d.)]+/, "")
		.replace(/^questions?:\s*/i, "")
		.replace(/^question:\s*/i, "")
		.replace(/^here(?: are|'re)? the questions:?\s*/i, "")
		.trim();
	if (!cleaned.includes("?")) {
		return null;
	}
	return cleaned;
}
