import test from "node:test";
import assert from "node:assert/strict";
import { extractQuestionsFromText, parseExtractionResult } from "./answer-parser.ts";

test("parseExtractionResult accepts the expected questions object", () => {
	const parsed = parseExtractionResult(JSON.stringify({
		questions: [
			{ question: "What is your preferred database?", context: "Only PostgreSQL and MySQL are supported." },
		],
	}));

	assert.deepEqual(parsed, {
		questions: [
			{ question: "What is your preferred database?", context: "Only PostgreSQL and MySQL are supported." },
		],
	});
});

test("parseExtractionResult extracts JSON wrapped in surrounding prose", () => {
	const parsed = parseExtractionResult(`Here is the JSON you requested:\n\n{
  "questions": [
    { "question": "Should we use TypeScript?" }
  ]
}\n\nLet me know if you want anything else.`);

	assert.deepEqual(parsed, {
		questions: [{ question: "Should we use TypeScript?" }],
	});
});

test("parseExtractionResult extracts fenced JSON code blocks", () => {
	const parsed = parseExtractionResult(`\
\
\
\`\`\`json
{
  "questions": [
    {
      "question": "Do you want retries enabled?",
      "context": "This affects API resiliency."
    }
  ]
}
\`\`\`
`);

	assert.deepEqual(parsed, {
		questions: [{ question: "Do you want retries enabled?", context: "This affects API resiliency." }],
	});
});

test("parseExtractionResult tolerates common schema drift from the extractor", () => {
	const parsed = parseExtractionResult(JSON.stringify([
		"What environment should we deploy to?",
		{ question: "Do you need a rollback plan?", context: "For production deploys." },
	]));

	assert.deepEqual(parsed, {
		questions: [
			{ question: "What environment should we deploy to?" },
			{ question: "Do you need a rollback plan?", context: "For production deploys." },
		],
	});
});

test("extractQuestionsFromText finds numbered plain-text questions", () => {
	const parsed = extractQuestionsFromText(`1. What are you trying to get done right now?\n2. What part of /answer feels most broken to you?\n3. If /answer worked perfectly, what would it do next?`);

	assert.deepEqual(parsed, [
		{ question: "What are you trying to get done right now?" },
		{ question: "What part of /answer feels most broken to you?" },
		{ question: "If /answer worked perfectly, what would it do next?" },
	]);
});

test("parseExtractionResult returns empty questions for explicit no-question responses", () => {
	assert.deepEqual(parseExtractionResult("No questions found."), { questions: [] });
});
