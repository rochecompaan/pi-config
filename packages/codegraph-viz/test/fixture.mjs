import { DatabaseSync } from "node:sqlite";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Builds a minimal .codegraph/codegraph.db matching the schema subset
// lib/extract.mjs reads. 5 nodes: 2 files (src/a.ts, src/b.ts) and 3 symbols
// (fn:greet in a.ts; fn:main and cls:Greeter in b.ts). 6 edges: 3 contains
// plus calls (main→greet, cross-file), instantiates (main→Greeter, intra-file),
// references (Greeter→greet, cross-file). fn:main's docstring is 600 chars to
// exercise trimming.
export function createFixtureProject() {
  const dir = mkdtempSync(join(tmpdir(), "cgv-fixture-"));
  mkdirSync(join(dir, ".codegraph"));
  const db = new DatabaseSync(join(dir, ".codegraph", "codegraph.db"));
  db.exec(`
    CREATE TABLE nodes (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL, name TEXT, qualified_name TEXT,
      file_path TEXT, language TEXT, start_line INTEGER, end_line INTEGER,
      signature TEXT, docstring TEXT
    );
    CREATE TABLE edges (
      id INTEGER PRIMARY KEY, source TEXT NOT NULL, target TEXT NOT NULL,
      kind TEXT NOT NULL
    );
  `);
  const ins = db.prepare(`INSERT INTO nodes
    (id, kind, name, qualified_name, file_path, language, start_line, end_line, signature, docstring)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  ins.run("file:src/a.ts", "file", "a.ts", "src/a.ts", "src/a.ts", "typescript", 1, 4, null, null);
  ins.run("file:src/b.ts", "file", "b.ts", "src/b.ts", "src/b.ts", "typescript", 1, 9, null, null);
  ins.run("fn:greet", "function", "greet", "greet", "src/a.ts", "typescript", 1, 3, "greet(name: string): string", "Says hi.");
  ins.run("fn:main", "function", "main", "main", "src/b.ts", "typescript", 1, 4, "main(): string", "x".repeat(600));
  ins.run("cls:Greeter", "class", "Greeter", "Greeter", "src/b.ts", "typescript", 5, 9, null, null);
  const eins = db.prepare("INSERT INTO edges (source, target, kind) VALUES (?, ?, ?)");
  eins.run("file:src/a.ts", "fn:greet", "contains");
  eins.run("file:src/b.ts", "fn:main", "contains");
  eins.run("file:src/b.ts", "cls:Greeter", "contains");
  eins.run("fn:main", "fn:greet", "calls");
  eins.run("fn:main", "cls:Greeter", "instantiates");
  eins.run("cls:Greeter", "fn:greet", "references");
  db.close();
  return { dir };
}
