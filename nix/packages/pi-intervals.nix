{ pkgs }:

pkgs.buildNpmPackage {
  pname = "pi-intervals";
  version = "0.1.0-c94d30f";

  src = pkgs.fetchFromGitHub {
    owner = "sixfeetup";
    repo = "pi-intervals";
    rev = "c94d30faa746158ae8c44c103f893e0a04f88d38";
    hash = "sha256-sudXd3blxXN1tNZ84hIwWP+ExLkUt1Tbr01obFECGF0=";
  };

  npmDepsHash = "sha256-DJWK6Vw7H8GJJQSkoFNAbI5Mkecq5S3LpQtOdqZVSO0=";

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
