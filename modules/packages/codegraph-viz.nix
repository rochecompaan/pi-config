{ ... }:
{
  perSystem =
    { pkgs, ... }:
    let
      package = import ../../nix/packages/codegraph-viz.nix { inherit pkgs; };
    in
    {
      packages."codegraph-viz" = package;

      checks."codegraph-viz-tests" =
        pkgs.runCommand "codegraph-viz-tests" { nativeBuildInputs = [ pkgs.nodejs_24 ]; }
          ''
            # npm writes logs under HOME even when every test passes.
            export HOME="$TMPDIR/home"
            mkdir -p "$HOME"
            cp -r ${../../packages/codegraph-viz} src
            chmod -R u+w src
            cd src
            ${pkgs.nodejs_24}/bin/npm test
            touch $out
          '';
    };
}
