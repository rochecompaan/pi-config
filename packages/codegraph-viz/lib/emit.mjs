import { gzipSync, gunzipSync } from "node:zlib";

const PAYLOAD_RE = /<script type="application\/octet-stream" id="payload">\s*([A-Za-z0-9+/=]+)\s*<\/script>/;

const CSS = `
:root { color-scheme: dark; }
* { box-sizing: border-box; }
body { margin: 0; background: #1a1b26; color: #c0caf5; font: 13px/1.4 system-ui, sans-serif; overflow: hidden; }
#graph { position: fixed; inset: 0; display: block; }
#hud { position: fixed; top: 10px; left: 10px; display: flex; gap: 8px; align-items: center; }
#search { background: #24283b; color: #c0caf5; border: 1px solid #3b4261; border-radius: 4px; padding: 4px 8px; width: 220px; }
#toggles { display: flex; gap: 6px; background: #24283bcc; padding: 4px 8px; border-radius: 4px; }
#toggles label { display: flex; gap: 3px; align-items: center; cursor: pointer; }
#legend { position: fixed; bottom: 28px; left: 10px; background: #24283bcc; padding: 6px 8px; border-radius: 4px; max-width: 260px; }
#legend .sw { display: inline-block; width: 9px; height: 9px; border-radius: 50%; margin-right: 5px; }
#legend .row { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
#sidebar { position: fixed; top: 0; right: 0; width: 320px; height: 100vh; overflow-y: auto; background: #1f2335ee; border-left: 1px solid #3b4261; padding: 14px; }
#sidebar h2 { margin: 0 0 4px; font-size: 15px; word-break: break-all; }
#sidebar .kind { color: #7dcfff; text-transform: uppercase; font-size: 11px; letter-spacing: 0.05em; }
#sidebar .loc { color: #565f89; margin-bottom: 8px; }
#sidebar pre { background: #24283b; padding: 8px; border-radius: 4px; white-space: pre-wrap; word-break: break-word; }
#footer { position: fixed; bottom: 0; left: 0; right: 0; padding: 4px 10px; background: #1f2335; color: #565f89; font-size: 12px; }
`;

export function buildHtml(model, viewerJs) {
  const payload = gzipSync(JSON.stringify(model), { level: 9 }).toString("base64");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>codegraph-viz — ${escapeHtml(model.meta.project)}</title>
<style>${CSS}</style>
</head>
<body>
<canvas id="graph"></canvas>
<div id="hud">
  <input id="search" type="search" placeholder="Search symbols…" autocomplete="off">
  <div id="toggles"></div>
</div>
<div id="legend"></div>
<aside id="sidebar" hidden></aside>
<footer id="footer"></footer>
<script type="application/octet-stream" id="payload">
${payload}
</script>
<script>
${viewerJs}
</script>
</body>
</html>
`;
}

export function extractPayload(html) {
  const match = html.match(PAYLOAD_RE);
  if (!match) throw new Error("no payload block found");
  return JSON.parse(gunzipSync(Buffer.from(match[1], "base64")).toString("utf8"));
}

function escapeHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
