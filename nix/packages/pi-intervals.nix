{ pkgs }:

pkgs.buildNpmPackage {
  pname = "pi-intervals";
  version = "0.1.0-2d4e1c9";

  src = pkgs.fetchFromGitHub {
    owner = "sixfeetup";
    repo = "pi-intervals";
    rev = "2d4e1c937ba7f88420511c83e1a3317e1f3194b4";
    hash = "sha256-hkHBW1urW0rxKnJ7Ws+/a7/x/lvQ3lUv9zQ8T2HQiH8=";
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
