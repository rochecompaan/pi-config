{ pkgs }:
let
  pins = (builtins.fromJSON (builtins.readFile ../dependency-pins.json))."pi-intervals";
in
pkgs.buildNpmPackage {
  pname = "pi-intervals";
  inherit (pins) version;

  # dependency-source: pi-intervals
  src = pkgs.fetchFromGitHub {
    owner = "sixfeetup";
    repo = "pi-intervals";
    inherit (pins) rev hash;
  };

  inherit (pins) npmDepsHash;

  dontNpmBuild = true;

  installPhase = ''
    runHook preInstall

    mkdir -p "$out"
    cp -r package.json package-lock.json src skills node_modules "$out/"

    runHook postInstall
  '';

  meta = {
    description = "Pi extension and skill for Intervals time tracking";
    homepage = "https://github.com/sixfeetup/pi-intervals";
    license = pkgs.lib.licenses.mit;
  };
}
