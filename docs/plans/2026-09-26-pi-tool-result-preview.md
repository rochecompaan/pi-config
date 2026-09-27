# Pi Tool-Result Preview Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task by task.

**Goal:** Make collapsed fallback tool results cheap to rebuild by limiting preview work before ANSI and binary sanitization, while preserving the complete result after expansion.

**Architecture:** Keep the behavioral change in Pi's `ToolExecutionComponent`. Maintain one upstream TypeScript-and-Vitest patch as the readable source of truth. Build that source once, derive a second patch for the compiled Pi 0.87.1 npm artifact, and apply the compiled patch through one focused Nix derivation wrapper used by both Pi consumers in this repository. Run a real component regression test during the patched derivation's check phase.

**Tech Stack:** TypeScript, Vitest, Node's built-in test runner, Nix, `buildNpmPackage`, Bun-built Pi package, Git patches.

**Design:** `docs/specs/2026-09-26-pi-tool-result-preview-design.md`

---

## Fixed behavior and limits

Use these constants in both source and compiled patches:

```ts
const FALLBACK_PREVIEW_LINES = 10;
const FALLBACK_PREVIEW_TEXT_CHARACTERS = 10_000;
const FALLBACK_PREVIEW_COLUMNS = 500;
```

The collapsed path must:

1. Copy at most 10,000 text characters across all text blocks before calling `getRenderedTextOutput()`.
2. Preserve every non-text block, including image blocks, in the preview result.
3. Sanitize only the bounded preview result.
4. Keep at most 10 sanitized lines.
5. Limit each kept line to 500 terminal columns with `truncateToWidth()`.
6. Show an expansion hint if the character, line, or column limit omitted content.
7. Use a generic `output truncated` reason when the character limit applies. Do not report an exact remaining-line count from incomplete input.
8. Pass the original result to `getRenderedTextOutput()` when expanded.
9. Apply the same bounded text path when the saved tool no longer has a loaded definition.
10. Leave custom `renderResult` functions unchanged.

## Files

Create:

- `patches/pi-tool-result-preview-upstream.patch`
- `nix/packages/pi-tool-result-preview-dist.patch`
- `nix/packages/pi-tool-result-preview.test.mjs`
- `nix/packages/pi-with-tool-result-preview.nix`

Modify:

- `modules/packages/pi.nix`
- `modules/packages/pi-config.nix`

Do not modify:

- `extensions/context-paging/**`
- `flake.lock`
- the pinned Pi version
- Pi source copied into this repository

---

### Task 1: Produce and verify the upstream source patch

**Files:**
- Create: `patches/pi-tool-result-preview-upstream.patch`
- Temporary source checkout: `/tmp/pi-tool-result-preview-upstream/packages/coding-agent/src/modes/interactive/components/tool-execution.ts`
- Temporary upstream test: `/tmp/pi-tool-result-preview-upstream/packages/coding-agent/test/tool-execution-component.test.ts`

#### Step 1: Prepare a clean Pi 0.87.1 checkout

Run from the feature worktree:

```sh
rm -rf /tmp/pi-tool-result-preview-upstream /tmp/pi-tool-result-preview-upstream-check
git clone --branch v0.87.1 --depth 1 https://github.com/earendil-works/pi.git /tmp/pi-tool-result-preview-upstream
cd /tmp/pi-tool-result-preview-upstream
npm ci
```

Confirm the base version and clean state:

```sh
node -p 'require("./packages/coding-agent/package.json").version'
git status --short
```

Expected:

```text
0.87.1
```

`git status --short` must print nothing.

#### Step 2: Add the upstream regression tests first

In `packages/coding-agent/test/tool-execution-component.test.ts`, add focused tests beside the existing `collapses fallback results until expanded` test. Reuse the existing `createBaseToolDefinition()`, `createFakeTui()`, `initTheme()`, and `stripAnsi()` helpers.

Use a helper with this shape:

```ts
function createFallbackComponent(toolDefinition: ToolDefinition | undefined): ToolExecutionComponent {
	return new ToolExecutionComponent(
		"custom_tool",
		"tool-preview",
		{},
		{ showImages: false },
		toolDefinition,
		createFakeTui(),
		process.cwd(),
	);
}

function renderText(component: ToolExecutionComponent, width = 20_000): string {
	return stripAnsi(component.render(width).join("\n"));
}
```

Add all six behavior cases below.

1. **Slice before sanitization.** Use a string-shaped guard whose `replace()` throws and whose `slice(0, 10_000)` returns a primitive string:

```ts
test("bounds fallback text before sanitizing a collapsed result", () => {
	const slice = vi.fn((start: number, end: number) => {
		expect(start).toBe(0);
		expect(end).toBe(FALLBACK_PREVIEW_TEXT_CHARACTERS);
		return "bounded preview";
	});
	const guardedText = {
		length: 20_000,
		slice,
		replace: () => {
			throw new Error("sanitized unbounded text");
		},
	} as unknown as string;
	const component = createFallbackComponent(createBaseToolDefinition());

	expect(() =>
		component.updateResult(
			{ content: [{ type: "text", text: guardedText }], details: {}, isError: false },
			false,
		),
	).not.toThrow();
	expect(slice).toHaveBeenCalledOnce();
	expect(renderText(component)).toContain("bounded preview");
});
```

The constant is module-private. In the test, assert the literal `10_000` if importing the constant would expand the public API.

2. **One long line.** Use `${"x".repeat(12_000)}TAIL_MARKER`. In the collapsed render, assert that `TAIL_MARKER` is absent, `output truncated` is present, and 501 consecutive `x` characters are absent. After `setExpanded(true)`, assert that `TAIL_MARKER` is present.

3. **More than 10 lines.** Use 12 named lines under 10,000 characters. Assert that the collapsed render contains line 10, omits line 11, and contains `2 more lines`. Expand and assert that line 12 appears.

4. **Missing tool definition.** Construct with `undefined`, use a result longer than 10,000 characters with a tail marker, and make the same collapsed/expanded assertions. This exercises `formatToolExecution()` rather than `createResultFallback()`.

5. **Image block after the text limit.** Use a 10,001-character text block followed by a 1×1 PNG image block with `showImages: false`. Assert that the collapsed render still contains an image fallback marker with `/image/i`. This prevents a preview implementation from dropping all content after the text budget reaches zero.

6. **Short fallback unchanged.** Use a short two-line result. Assert that both lines appear and no `to expand` hint appears.

#### Step 3: Run the focused test and confirm RED

```sh
cd /tmp/pi-tool-result-preview-upstream
npm test --workspace @earendil-works/pi-coding-agent -- tool-execution-component.test.ts
```

Expected: the new guarded-text, long-line, missing-definition, and/or image-preservation cases fail against Pi 0.87.1. The existing tests must still run. If the new tests pass without a source change, stop and inspect the fixture because it is not exercising the fallback path.

#### Step 4: Implement the bounded preview in TypeScript

In `packages/coding-agent/src/modes/interactive/components/tool-execution.ts`:

1. Add `truncateToWidth` to the existing `@earendil-works/pi-tui` import.
2. Add the three constants from **Fixed behavior and limits**.
3. Replace the string-only `getTextOutput()` return value with a `{ text, inputTruncated }` result.
4. Add one private formatter for the shared expansion hint.
5. Update `createResultFallback()` and `formatToolExecution()` to consume the new result.

Use this implementation shape:

```ts
private getTextOutput(): { text: string; inputTruncated: boolean } {
	if (!this.result || this.expanded) {
		return {
			text: getRenderedTextOutput(this.result, this.showImages),
			inputTruncated: false,
		};
	}

	let remainingCharacters = FALLBACK_PREVIEW_TEXT_CHARACTERS;
	let inputTruncated = false;
	const content = this.result.content.flatMap((block) => {
		if (block.type !== "text" || block.text === undefined) {
			return [block];
		}
		if (remainingCharacters === 0) {
			inputTruncated ||= block.text.length > 0;
			return [];
		}

		const text = block.text.slice(0, remainingCharacters);
		remainingCharacters -= text.length;
		inputTruncated ||= text.length < block.text.length;
		return [{ ...block, text }];
	});

	return {
		text: getRenderedTextOutput({ ...this.result, content }, this.showImages),
		inputTruncated,
	};
}

private formatExpansionHint(reason: string): string {
	return `${theme.fg("muted", `\n... (${reason},`)} ${keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`;
}
```

Update `createResultFallback()` with this order of operations:

```ts
const { text: output, inputTruncated } = this.getTextOutput();
if (!output) return undefined;

const lines = output.split("\n");
const previewLines = this.expanded ? lines : lines.slice(0, FALLBACK_PREVIEW_LINES);
const displayLines = this.expanded
	? previewLines
	: previewLines.map((line) => truncateToWidth(line, FALLBACK_PREVIEW_COLUMNS));
const remainingLines = lines.length - previewLines.length;
const hasTruncatedLine = displayLines.some((line, index) => line !== previewLines[index]);

let text = displayLines.map((line) => theme.fg("toolOutput", line)).join("\n");
if (!this.expanded && (inputTruncated || remainingLines > 0 || hasTruncatedLine)) {
	const reason = inputTruncated
		? "output truncated"
		: remainingLines > 0
			? `${remainingLines} more lines`
			: "line truncated";
	text += this.formatExpansionHint(reason);
}
return new Text(text, 0, 0);
```

Update `formatToolExecution()` so it appends `this.formatExpansionHint("output truncated")` only when `inputTruncated` is true. Keep the existing title, JSON arguments, and output order.

Do not route custom `renderResult` functions through this helper. The existing renderer selection already keeps that path separate.

#### Step 5: Run the focused tests and type/build checks

```sh
cd /tmp/pi-tool-result-preview-upstream
npm test --workspace @earendil-works/pi-coding-agent -- tool-execution-component.test.ts
npm run check
npm run build:unbundled --workspace @earendil-works/pi-coding-agent
```

Expected:

- The focused Vitest file passes.
- The monorepo check passes.
- `packages/coding-agent/dist/modes/interactive/components/tool-execution.js` is regenerated for Task 2.

#### Step 6: Export an upstream-ready patch

From the roche-pi feature worktree:

```sh
mkdir -p patches
git -C /tmp/pi-tool-result-preview-upstream diff --check
git -C /tmp/pi-tool-result-preview-upstream diff -- \
  packages/coding-agent/src/modes/interactive/components/tool-execution.ts \
  packages/coding-agent/test/tool-execution-component.test.ts \
  > patches/pi-tool-result-preview-upstream.patch

git clone --branch v0.87.1 --depth 1 https://github.com/earendil-works/pi.git /tmp/pi-tool-result-preview-upstream-check
git -C /tmp/pi-tool-result-preview-upstream-check apply --check \
  "$PWD/patches/pi-tool-result-preview-upstream.patch"
```

Inspect the patch header. It must contain only the TypeScript component and its Vitest file, with `a/` and `b/` paths suitable for `git apply -p1`.

#### Step 7: Verify and commit the upstream artifact

```sh
git diff --check
git diff -- patches/pi-tool-result-preview-upstream.patch
git add patches/pi-tool-result-preview-upstream.patch
git commit -m "chore(pi): add upstream tool preview patch"
```

#### Step 8: Review checkpoint

Request a fresh reviewer against the task's base and head SHAs. Give it:

- The design path.
- The upstream patch path.
- The six required behavior cases.
- The focused test, check, and build commands and their results.

Resolve all high- and medium-severity findings before Task 2. Rerun the focused upstream test after any patch change.

---

### Task 2: Add the downstream package regression test and prove RED

**Files:**
- Create: `nix/packages/pi-tool-result-preview.test.mjs`
- Create: `nix/packages/pi-with-tool-result-preview.nix`
- Modify: `modules/packages/pi.nix`
- Modify: `modules/packages/pi-config.nix`

#### Step 1: Port the behavior cases to a Node test

Create `nix/packages/pi-tool-result-preview.test.mjs`. It must import Pi's unbundled files from the build tree named by `PI_PACKAGE_ROOT`:

```js
import assert from "node:assert/strict";
import test from "node:test";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const packageRoot = process.env.PI_PACKAGE_ROOT;
assert.ok(packageRoot, "PI_PACKAGE_ROOT is required");
const fromPackage = (path) => pathToFileURL(resolve(packageRoot, path)).href;

const { ToolExecutionComponent } = await import(
	fromPackage("dist/modes/interactive/components/tool-execution.js")
);
const { initTheme } = await import(fromPackage("dist/modes/interactive/theme/theme.js"));
const { stripAnsi } = await import(fromPackage("dist/utils/ansi.js"));

initTheme("dark");

const fakeTui = { requestRender() {} };
const fallbackDefinition = {};

function createComponent(toolDefinition = fallbackDefinition) {
	return new ToolExecutionComponent(
		"custom_tool",
		"tool-preview",
		{},
		{ showImages: false },
		toolDefinition,
		fakeTui,
		process.cwd(),
	);
}

function renderText(component, width = 20_000) {
	return stripAnsi(component.render(width).join("\n"));
}
```

Port the same six assertions from Task 1 with Node's `assert` API:

- Guarded text: `assert.doesNotThrow()`, assert the slice arguments, and assert that the slice ran exactly once.
- Long one-line result: collapsed tail absent, `output truncated` present, 501-character run absent, expanded tail present.
- 12-line result: line 10 present, line 11 absent, `2 more lines` present, expanded line 12 present.
- Missing definition: pass `undefined` explicitly with a helper that does not replace it with the default. Assert bounded collapsed output and complete expanded output.
- Image after the text budget: `/image/i` matches the collapsed output.
- Short result: both lines present and no expansion hint.

For the missing-definition case, avoid the default-parameter trap by constructing the component directly or by adding a second helper:

```js
function createComponentWithoutDefinition() {
	return new ToolExecutionComponent(
		"missing_tool",
		"tool-missing",
		{},
		{ showImages: false },
		undefined,
		fakeTui,
		process.cwd(),
	);
}
```

#### Step 2: Create the Nix wrapper without the patch line

Create `nix/packages/pi-with-tool-result-preview.nix` in a temporary RED state:

```nix
{ pkgs, upstreamPi }:

upstreamPi.overrideAttrs (oldAttrs: {
  nativeCheckInputs = (oldAttrs.nativeCheckInputs or [ ]) ++ [ pkgs.nodejs ];
  doCheck = true;
  checkPhase = ''
    runHook preCheck
    PI_PACKAGE_ROOT="$PWD" \
      ${pkgs.nodejs}/bin/node --test ${./pi-tool-result-preview.test.mjs}
    runHook postCheck
  '';
})
```

Do not add `patches` yet. This state exists only to prove the package-level test detects Pi 0.87.1's bug.

#### Step 3: Route both Pi consumers through the wrapper

In `modules/packages/pi.nix`, keep the original input as `upstreamPi` and define the wrapped package once:

```nix
upstreamPi = inputs.llm-agents-nix.packages.${pkgs.stdenv.hostPlatform.system}.pi;
piPackage = import ../../nix/packages/pi-with-tool-result-preview.nix {
  inherit pkgs upstreamPi;
};
```

Pass this `piPackage` to `mkPiSkillsetWrapper`. Preserve the existing `replaceRuntime` logic and every launcher.

In `modules/packages/pi-config.nix`, make the same `upstreamPi`/`piPackage` split. Use the wrapped `piPackage` for:

- `piVersion`
- `mkPiSkillsetWrapper`
- the runtime extension-load check

Do not duplicate the override expression in either module.

#### Step 4: Run the downstream package build and confirm RED

```sh
nix build .#packages.x86_64-linux.pi --no-link --print-build-logs
```

Expected: the derivation reaches `pi-tool-result-preview.test.mjs` and fails on the unpatched collapsed fallback behavior. Confirm that the failure is from a behavior assertion, not from an import path, theme initialization, Nix syntax, or missing dependency.

If the test fails before exercising `ToolExecutionComponent`, fix only the harness and rerun until the behavioral failure is clear.

#### Step 5: Check the staged RED diff

```sh
git diff --check
git diff -- \
  nix/packages/pi-tool-result-preview.test.mjs \
  nix/packages/pi-with-tool-result-preview.nix \
  modules/packages/pi.nix \
  modules/packages/pi-config.nix
```

Do not commit the intentionally failing state.

---

### Task 3: Derive the compiled patch, make the package GREEN, and verify behavior

**Files:**
- Create: `nix/packages/pi-tool-result-preview-dist.patch`
- Modify: `nix/packages/pi-with-tool-result-preview.nix`
- Verify: `nix/packages/pi-tool-result-preview.test.mjs`
- Verify: `modules/packages/pi.nix`
- Verify: `modules/packages/pi-config.nix`

#### Step 1: Extract the exact Pi 0.87.1 npm artifact

```sh
rm -rf /tmp/pi-tool-result-preview-dist
mkdir -p /tmp/pi-tool-result-preview-dist
cd /tmp/pi-tool-result-preview-dist
npm pack @earendil-works/pi-coding-agent@0.87.1
mkdir original
tar -xzf earendil-works-pi-coding-agent-0.87.1.tgz -C original
```

Verify that both files exist:

```sh
test -f original/package/dist/modes/interactive/components/tool-execution.js
test -f /tmp/pi-tool-result-preview-upstream/packages/coding-agent/dist/modes/interactive/components/tool-execution.js
```

#### Step 2: Generate the compiled patch from the verified TypeScript build

Run from the roche-pi feature worktree:

```sh
old=/tmp/pi-tool-result-preview-dist/original/package/dist/modes/interactive/components/tool-execution.js
new=/tmp/pi-tool-result-preview-upstream/packages/coding-agent/dist/modes/interactive/components/tool-execution.js

set +e
diff -u \
  --label a/dist/modes/interactive/components/tool-execution.js \
  --label b/dist/modes/interactive/components/tool-execution.js \
  "$old" "$new" \
  > nix/packages/pi-tool-result-preview-dist.patch
status=$?
set -e
test "$status" -eq 1
```

This file must be derived from the TypeScript build. Do not hand-maintain a second algorithm.

Check the patch:

```sh
mkdir -p /tmp/pi-tool-result-preview-dist/check
tar -xzf /tmp/pi-tool-result-preview-dist/earendil-works-pi-coding-agent-0.87.1.tgz \
  -C /tmp/pi-tool-result-preview-dist/check
patch -d /tmp/pi-tool-result-preview-dist/check/package -p1 --dry-run \
  < nix/packages/pi-tool-result-preview-dist.patch
```

Expected: one clean hunk set against `dist/modes/interactive/components/tool-execution.js`.

#### Step 3: Enable the patch in the Nix wrapper

Add the `patches` attribute before the check configuration:

```nix
upstreamPi.overrideAttrs (oldAttrs: {
  patches = (oldAttrs.patches or [ ]) ++ [ ./pi-tool-result-preview-dist.patch ];

  nativeCheckInputs = (oldAttrs.nativeCheckInputs or [ ]) ++ [ pkgs.nodejs ];
  doCheck = true;
  checkPhase = ''
    runHook preCheck
    PI_PACKAGE_ROOT="$PWD" \
      ${pkgs.nodejs}/bin/node --test ${./pi-tool-result-preview.test.mjs}
    runHook postCheck
  '';
})
```

Keep the wrapper limited to three responsibilities: apply the patch, add Node for the check, and run the behavior test.

#### Step 4: Run the focused package build and confirm GREEN

```sh
nix build .#packages.x86_64-linux.pi --no-link --print-build-logs
```

Expected:

- The compiled patch applies.
- All six Node subtests pass.
- The Pi wrapper package builds.

Run once more after deleting the result symlink if one exists, or with a harmless derivation change reverted, to confirm the success is not from the earlier unpatched cache entry.

#### Step 5: Run the real 36 MB reconstruction benchmark

Create `/tmp/pi-tool-result-preview-benchmark.mjs` from **Appendix A**. Prepare an importable Pi package and apply the same compiled patch:

```sh
rm -rf /tmp/pi-tool-result-preview-benchmark-package
mkdir /tmp/pi-tool-result-preview-benchmark-package
cd /tmp/pi-tool-result-preview-benchmark-package
npm init -y >/dev/null
npm install --ignore-scripts @earendil-works/pi-coding-agent@0.87.1
patch -d node_modules/@earendil-works/pi-coding-agent -p1 \
  < "$ROCHE_PI_WORKTREE/nix/packages/pi-tool-result-preview-dist.patch"
```

Set `ROCHE_PI_WORKTREE` to the absolute feature-worktree path before the command. Then run:

```sh
PI_PACKAGE_DIR=/tmp/pi-tool-result-preview-benchmark-package/node_modules/@earendil-works/pi-coding-agent \
PI_SESSION="$HOME/.pi/agent/sessions/2026-09-24T09-03-00-870Z_01a0d2a7-6505-72c8-853b-47a50465db5e.jsonl" \
node /tmp/pi-tool-result-preview-benchmark.mjs
```

Expected:

- `sessionMB` is approximately `36.2`.
- `totalMs` is less than `1000` on the same machine used for the 23.2-second baseline.
- `toolMs` is less than `1000`.
- The script reports 241 completed tool results on the full active branch, unless the local session file has changed.

Run the same benchmark against an unpatched npm install only if the baseline needs to be re-established. Do not make a brittle wall-clock assertion part of the Nix build; the guarded-text test proves the bounded-work property deterministically.

#### Step 6: Commit the downstream fix

```sh
git diff --check
git status --short
git add \
  nix/packages/pi-tool-result-preview-dist.patch \
  nix/packages/pi-tool-result-preview.test.mjs \
  nix/packages/pi-with-tool-result-preview.nix \
  modules/packages/pi.nix \
  modules/packages/pi-config.nix
git commit -m "fix(pi): bound collapsed tool result previews"
```

#### Step 7: Review checkpoint

Request a fresh reviewer against the Task 2 base SHA and current head SHA. Supply:

- The design and plan paths.
- Both patch files.
- The Nix wrapper and both consumer modules.
- RED and GREEN package-build evidence.
- Benchmark output.

Ask specifically about:

- Full-result restoration on expansion.
- Image-block preservation after the text budget is exhausted.
- Missing-definition behavior.
- Source/compiled patch parity.
- Nix phase order and whether the test imports the patched unbundled file before Bun assembly.
- Unintended effects on custom renderers.

Resolve all high- and medium-severity findings and rerun the package build and benchmark after changes.

---

### Task 4: Run repository verification and prepare completion

**Files:**
- Verify all changed files.
- Do not add tests that assert Nix source text, patch text, lock contents, or documentation text.

#### Step 1: Run the mandatory Pi runtime extension-load check

```sh
nix build .#checks.x86_64-linux.pi-config-extension-load --no-link --print-build-logs
```

Expected: the Home Manager-like Pi startup reaches only the expected invalid-provider/API-key failure stage. There must be no `Failed to load extension`, missing built-in module, or missing package error.

#### Step 2: Run the full flake check

```sh
nix flake check --accept-flake-config --print-build-logs
```

Expected: all checks pass.

#### Step 3: Re-run the focused package and upstream tests

```sh
nix build .#packages.x86_64-linux.pi --no-link --print-build-logs
cd /tmp/pi-tool-result-preview-upstream
npm test --workspace @earendil-works/pi-coding-agent -- tool-execution-component.test.ts
```

Expected: all downstream Node subtests and upstream Vitest cases pass.

#### Step 4: Confirm patch provenance and removal seam

Run:

```sh
git show --stat --oneline HEAD~1..HEAD
git diff --check HEAD~2..HEAD
grep -RIn "pi-with-tool-result-preview" modules/packages nix/packages
```

Confirm:

- Both consumers import the same wrapper.
- Only the wrapper applies the compiled patch.
- The upstream patch contains TypeScript plus Vitest changes.
- The compiled patch changes only the generated `tool-execution.js` file.
- Removing the wrapper, two patches, test file, and two consumer imports is sufficient when an upstream Pi release includes the fix.

The grep is direct verification of a Nix wiring seam. Do not add an automated test that merely asserts static Nix text.

#### Step 5: Final adversarial review

Request one final fresh review of the full feature diff from the worktree base SHA to `HEAD`. Include:

- Design and plan.
- Base and head SHAs.
- All verification commands and results.
- The measured benchmark result.
- The intended temporary-removal path.

Resolve all blocking findings. Rerun every command affected by a correction.

#### Step 6: Report completion options

Summarize:

- Behavioral fix and limits.
- Upstream and compiled patch locations.
- RED/GREEN evidence.
- Package, extension-load, and full-flake results.
- 36 MB benchmark result.
- Any residual risk.

Then offer the branch-completion choices from `superpowers:finishing-a-development-branch`. If the user chooses local integration, offer a **squash merge into `main`**, not a regular merge.

---

## Appendix A: Real transcript reconstruction benchmark

Write this exact script to `/tmp/pi-tool-result-preview-benchmark.mjs` during Task 3. It reads no transcript content into terminal output. It reports counts and timings only.

```js
import { statSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";

const packageDir = process.env.PI_PACKAGE_DIR;
const sessionPath = process.env.PI_SESSION;
if (!packageDir || !sessionPath) {
	throw new Error("PI_PACKAGE_DIR and PI_SESSION are required");
}

const pi = await import(pathToFileURL(`${packageDir}/dist/index.js`).href);
pi.initTheme(undefined, false);

function text(content) {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((block) => block?.type === "text")
		.map((block) => block.text ?? "")
		.join("");
}

function rebuild(messages, cwd) {
	const pending = new Map();
	const stats = {
		assistantMs: 0,
		completedTools: 0,
		lines: 0,
		maxToolMs: 0,
		toolChars: 0,
		toolMs: 0,
		userMs: 0,
	};
	const ui = { requestRender() {} };
	const started = performance.now();

	for (const message of messages) {
		let itemStarted = performance.now();
		if (message.role === "user") {
			const component = new pi.UserMessageComponent(text(message.content));
			stats.lines += component.render(160).length;
			stats.userMs += performance.now() - itemStarted;
			continue;
		}
		if (message.role === "assistant") {
			const component = new pi.AssistantMessageComponent(message, true);
			stats.lines += component.render(160).length;
			stats.assistantMs += performance.now() - itemStarted;
			for (const block of message.content ?? []) {
				if (block?.type !== "toolCall") continue;
				pending.set(
					block.id,
					new pi.ToolExecutionComponent(
						block.name,
						block.id,
						block.arguments,
						{ showImages: false, imageWidthCells: 60 },
						undefined,
						ui,
						cwd,
					),
				);
			}
			continue;
		}
		if (message.role !== "toolResult") continue;

		const component = pending.get(message.toolCallId);
		if (!component) continue;
		const characters = text(message.content).length;
		itemStarted = performance.now();
		component.updateResult(message);
		stats.lines += component.render(160).length;
		const elapsed = performance.now() - itemStarted;
		stats.completedTools += 1;
		stats.toolChars += characters;
		stats.toolMs += elapsed;
		stats.maxToolMs = Math.max(stats.maxToolMs, elapsed);
		pending.delete(message.toolCallId);
	}

	return { ...stats, totalMs: performance.now() - started };
}

const session = pi.SessionManager.open(sessionPath);
const projection = session.buildSessionProjection();
const result = rebuild(projection.messages, session.getCwd());
console.log(
	JSON.stringify(
		{
			sessionMB: Number((statSync(sessionPath).size / 1e6).toFixed(1)),
			messages: projection.messages.length,
			completedTools: result.completedTools,
			toolMB: Number((result.toolChars / 1e6).toFixed(1)),
			totalMs: Number(result.totalMs.toFixed(1)),
			toolMs: Number(result.toolMs.toFixed(1)),
			maxToolMs: Number(result.maxToolMs.toFixed(1)),
			renderedLines: result.lines,
		},
		null,
		2,
	),
);
```
