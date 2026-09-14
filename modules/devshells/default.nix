{ ... }:
{
  perSystem =
    {
      config,
      pkgs,
      self',
      ...
    }:
    {
      devShells.default = pkgs.mkShell {
        packages = [
          self'.packages.pi
          self'.packages.pi-matt
          self'.packages.codegraph
          self'.packages.codegraph-viz
          self'.packages.pi-local-auth
          pkgs.git
          pkgs.jq
          pkgs.nixfmt-rfc-style
        ];

        shellHook = config.lib.projectPiShellHook { };
      };
      formatter = pkgs.nixfmt-rfc-style;
    };
}
