{ pkgs }:
let
  packageLock = ../../resources/pi-remote-package-lock.json;

  src = pkgs.fetchzip {
    url = "https://registry.npmjs.org/@noahsaso/pi-remote/-/pi-remote-0.3.1.tgz";
    hash = "sha256-d8tSk12rnZqHr2HDVnXclZBRPbqRPVft9CKYSdBJHr8=";
  };
in
pkgs.buildNpmPackage {
  pname = "pi-remote";
  version = "0.3.1";
  inherit src;

  npmDepsHash = "sha256-DucFlnKAAd8sFUptf5zapAXqYrf7OZn3/xNFHySAApc=";

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
