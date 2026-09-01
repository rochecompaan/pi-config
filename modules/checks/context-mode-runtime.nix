{ ... }:
{
  perSystem =
    {
      pkgs,
      self',
      ...
    }:
    let
      contextMode = self'.packages."context-mode";
      bridge = "${contextMode}/lib/node_modules/context-mode/build/adapters/pi/mcp-bridge.js";
      server = "${contextMode}/lib/node_modules/context-mode/server.bundle.mjs";
    in
    {
      checks.context-mode-runtime = pkgs.runCommand "context-mode-runtime" { } ''
        export HOME="$TMPDIR/home"
        export PATH="${pkgs.nodejs_20}/bin:${pkgs.coreutils}/bin"
        mkdir -p "$HOME/.pi"

        cat > "$TMPDIR/probe.mjs" <<'JS'
        import { MCPStdioClient } from "${bridge}";

        const client = new MCPStdioClient("${server}");
        const markerParts = ["CONTEXT", "MODE", "RUNTIME", "INDEXED"];
        const marker = markerParts.join("_");

        async function withTimeout(label, promise) {
          let timer;
          const deadline = new Promise((_, reject) => {
            timer = setTimeout(
              () => reject(new Error(label + " timed out")),
              30_000,
            );
          });
          try {
            return await Promise.race([promise, deadline]);
          } finally {
            clearTimeout(timer);
          }
        }

        client.start();

        try {
          await client.initialize();
          const execution = await withTimeout(
            "ctx_execute",
            client.callTool("ctx_execute", {
              language: "javascript",
              code:
                "const marker = " +
                JSON.stringify(markerParts) +
                ".join('_'); console.log(marker + '\\n' + 'x'.repeat(6000));",
              intent: "runtime check",
            }),
          );
          if (execution?.isError) {
            throw new Error(
              "context-mode execution failed: " + JSON.stringify(execution),
            );
          }

          const search = await withTimeout(
            "ctx_search",
            client.callTool("ctx_search", {
              queries: [markerParts.join(" ")],
            }),
          );
          const searchText = JSON.stringify(search);
          if (search?.isError || !searchText.includes(marker)) {
            throw new Error("context-mode search failed: " + searchText);
          }
        } finally {
          client.shutdown();
        }
        JS

        ${pkgs.nodejs_20}/bin/node "$TMPDIR/probe.mjs"
        touch "$out"
      '';
    };
}
