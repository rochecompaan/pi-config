{ pkgs }:
pkgs.runCommand "codegraph-viz-0.1.0" { } ''
  mkdir -p $out/libexec/codegraph-viz $out/bin
  cp -r ${../../packages/codegraph-viz}/. $out/libexec/codegraph-viz/
  cat > $out/bin/codegraph-viz <<EOF
  #!${pkgs.runtimeShell}
  exec ${pkgs.nodejs_24}/bin/node $out/libexec/codegraph-viz/viz.mjs "\$@"
  EOF
  chmod +x $out/bin/codegraph-viz
''
