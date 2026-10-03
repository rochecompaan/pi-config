{ pkgs }:
let
  pins = (builtins.fromJSON (builtins.readFile ../dependency-pins.json))."pi-remote";
  packageLock = ../../pi-remote-package-lock.json;

  # dependency-source: pi-remote
  src = pkgs.fetchzip {
    inherit (pins) url hash;
  };
in
pkgs.buildNpmPackage {
  pname = "pi-remote";
  inherit (pins) version;
  inherit src;

  inherit (pins) npmDepsHash;

  dontNpmBuild = true;
  makeCacheWritable = true;
  npmRebuildFlags = [ "node-pty" ];

  postPatch = ''
    cp ${packageLock} package-lock.json
    ${pkgs.nodejs}/bin/node <<'NODE'
    const fs = require("node:fs");
    const packagePath = "package.json";
    const packageJson = JSON.parse(fs.readFileSync(packagePath, "utf8"));
    delete packageJson.devDependencies;
    packageJson.scripts = {};
    fs.writeFileSync(packagePath, JSON.stringify(packageJson, null, 2));
    NODE
  '';
}
