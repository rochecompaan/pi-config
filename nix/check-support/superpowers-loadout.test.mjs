import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

const { default: superpowers } = await import(pathToFileURL(resolve(
  process.env.SUPERPOWERS_PACKAGE,
  ".pi/extensions/superpowers.ts",
)).href);
const marker = "superpowers:using-superpowers bootstrap for pi";

// The extension is real; this harness supplies only Pi's event/context boundary.
function session(initialSkills = [], { addendum = "", project = "" } = {}) {
  const handlers = new Map();
  let prompt;
  const select = (skills) => {
    // Mirror Pi's ordered sections, including earlier free-form instructions.
    const sections = [
      "You are a coding assistant.",
      `<addendum>\n${addendum}\n</addendum>`,
      `<project_context>\n<project_instructions path=\"/project/AGENTS.md\">\n${project}\n</project_instructions>\n</project_context>`,
    ];
    if (skills.length) sections.push(`<skills>\nThe following skills provide specialized instructions for specific tasks.
Use the read tool to load a skill's file when the task matches its description.
When a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.

<available_skills>
${skills.map((name) => `  <skill>
    <name>${name}</name>
    <description>Test skill</description>
    <location>/skills/${name}/SKILL.md</location>
  </skill>`).join("\n")}
</available_skills>
</skills>`);
    sections.push("<cwd>\n/project\n</cwd>");
    prompt = sections.join("\n\n");
  };
  select(initialSkills);
  superpowers({ on: (event, handler) => handlers.set(event, handler) });
  const emit = (event, payload = {}) => handlers.get(event)?.(payload, {
    cwd: "/project",
    getSystemPrompt: () => prompt,
  });
  const context = (messages = []) => emit("context", { messages });
  return { emit, context, select, setPrompt: (value) => { prompt = value; } };
}

function hasReminder(result) {
  return JSON.stringify(result?.messages ?? []).includes(marker);
}

test("does not inject with no active skills", async () => {
  const s = session();
  await s.emit("session_start");
  assert.equal(await s.context(), undefined);
});

test("individual Superpowers skills do not opt into the bootstrap", async () => {
  const s = session(["test-driven-development", "systematic-debugging"]);
  assert.equal(await s.context(), undefined);
});

test("a mention outside the advertised skill block does not enable the reminder", async () => {
  const s = session();
  s.setPrompt("Instructions mention <name>using-superpowers</name>.\n<available_skills></available_skills>");
  assert.equal(await s.context(), undefined);
});

const enabledDecoy = "<available_skills><skill><name>using-superpowers</name></skill></available_skills>";
const emptyDecoy = "<available_skills></available_skills>";

for (const section of ["addendum", "project"]) {
  test(`${section} skill markup cannot enable a disabled bootstrap`, async () => {
    const s = session(["tdd"], { [section]: enabledDecoy });
    assert.equal(await s.context(), undefined);
  });

  test(`${section} empty skill markup cannot suppress an enabled bootstrap`, async () => {
    const s = session(["using-superpowers"], { [section]: emptyDecoy });
    assert.equal(hasReminder(await s.context()), true);
  });
}

test("a nested skills section cannot enable a disabled bootstrap", async () => {
  const s = session(["tdd"], { addendum: `<skills>\n${enabledDecoy}\n</skills>` });
  assert.equal(await s.context(), undefined);
});

test("a nested empty skills section cannot suppress an enabled bootstrap", async () => {
  const s = session(["using-superpowers"], { addendum: `<skills>\n${emptyDecoy}\n</skills>` });
  assert.equal(hasReminder(await s.context()), true);
});

test("a decoy skills section does not substitute for absent advertised skills", async () => {
  const s = session([], { addendum: `<skills>\n${enabledDecoy}\n</skills>` });
  assert.equal(await s.context(), undefined);
});

for (const cwd of ["/example-from-docs", "/project"]) {
  test(`a paired skills/cwd example (${cwd}) cannot replace absent skills`, async () => {
    const s = session([], {
      addendum: `<skills>\n${enabledDecoy}\n</skills>\n\n<cwd>\n${cwd}\n</cwd>`,
    });
    assert.equal(await s.context(), undefined);
  });
}

test("a similarly named skill does not enable the reminder", async () => {
  const s = session(["using-superpowers-example"]);
  assert.equal(await s.context(), undefined);
});

test("enabling using-superpowers injects the real bootstrap", async () => {
  const s = session(["using-superpowers"]);
  await s.emit("session_start");
  assert.equal(hasReminder(await s.context()), true);
});

test("the reminder is not repeated on ordinary later runs", async () => {
  const s = session(["using-superpowers"]);
  assert.equal(hasReminder(await s.context()), true);
  await s.emit("agent_end");
  assert.equal(await s.context(), undefined);
});

test("enabling the skill after an inactive run issues the reminder", async () => {
  const s = session();
  await s.context();
  await s.emit("agent_end");
  s.select(["using-superpowers"]);
  assert.equal(hasReminder(await s.context()), true);
});

test("disabling and then re-enabling the skill re-arms the reminder", async () => {
  const s = session(["using-superpowers"]);
  await s.context();
  await s.emit("agent_end");
  s.select(["tdd"]);
  assert.equal(await s.context(), undefined);
  await s.emit("agent_end");
  s.select(["using-superpowers"]);
  assert.equal(hasReminder(await s.context()), true);
});

test("disabling the skill suppresses a pending reminder", async () => {
  const s = session(["using-superpowers"]);
  await s.emit("session_start");
  s.select([]);
  assert.equal(await s.context(), undefined);
});

test("compaction re-arms the reminder only while the skill is enabled", async () => {
  const s = session(["using-superpowers"]);
  await s.context();
  await s.emit("agent_end");
  await s.emit("session_compact");
  assert.equal(hasReminder(await s.context()), true);
  await s.emit("agent_end");
  s.select([]);
  await s.emit("session_compact");
  assert.equal(await s.context(), undefined);
});

test("an existing bootstrap is not duplicated", async () => {
  const s = session(["using-superpowers"]);
  const existing = { role: "user", content: [{ type: "text", text: marker }] };
  assert.equal(await s.context([existing]), undefined);
});

test("the bootstrap stays after compaction summaries and before user messages", async () => {
  const s = session(["using-superpowers"]);
  const summary = { role: "compactionSummary", content: "Earlier work" };
  const user = { role: "user", content: "Continue" };
  const result = await s.context([summary, user]);
  assert.equal(result.messages[0], summary);
  assert.equal(hasReminder({ messages: [result.messages[1]] }), true);
  assert.equal(result.messages[2], user);
});
