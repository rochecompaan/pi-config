{ ... }:
{
  perSystem =
    { pkgs, ... }:
    {
      packages.dependency-update-tools = pkgs.buildEnv {
        name = "dependency-update-tools";
        paths = [
          (pkgs.python3.withPackages (ps: [ ps.pyyaml ]))
          pkgs.nodejs
          # Node includes npm's SemVer CLI; nixpkgs 26.05 removed nodePackages.
          (pkgs.writeShellScriptBin "semver" ''
            exec ${pkgs.nodejs}/bin/node \
              ${pkgs.nodejs}/lib/node_modules/npm/node_modules/semver/bin/semver.js "$@"
          '')
          pkgs.git
          pkgs.nix
          pkgs.nix-prefetch-git
          pkgs.prefetch-npm-deps
          pkgs.patch
          pkgs.nixfmt-rfc-style
          pkgs.actionlint
        ];
      };
    };
}
