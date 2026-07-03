{ pkgs }:

pkgs.buildNpmPackage {
  pname = "pi-intervals";
  version = "0.1.0-f95c1bb";

  src = pkgs.fetchFromGitHub {
    owner = "sixfeetup";
    repo = "pi-intervals";
    rev = "f95c1bb9d87d2440b3750b561f25e958d4b81be7";
    hash = "sha256-T+mvd/fAVMENAmizCUjRp+BsMrFUvQG1/K4h0kCJnQc=";
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
