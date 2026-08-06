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

Toggle **3D** in the HUD for a rotatable overview: drag to orbit,
Shift+drag or right-drag to pan, double-click to reset the camera. The
third dimension encodes directory depth — deeply nested files sink below
top-level code, and heavily connected files drift toward each other's
layers.

Zero runtime dependencies (Node 24+ stdlib only). Layout is precomputed and
deterministic; the browser only renders.
