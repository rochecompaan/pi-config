# codegraph-viz

Render a [CodeGraph](https://github.com/colbymchenry/codegraph) index as a
single self-contained interactive HTML file — no server, no CDN, no
telemetry.

```sh
codegraph-viz [path] [-o out.html] [--max-nodes N] [--force]
```

Requires a project already indexed with `codegraph init -i`. Opens at the
file level; click a file to expand its symbols, click a symbol for its
details and caller/callee highlights, search with the box top-left, toggle
edge kinds in the HUD. ESC clears selection, then collapses all files.

Zero runtime dependencies (Node 24+ stdlib only). Layout is precomputed and
deterministic; the browser only renders.
