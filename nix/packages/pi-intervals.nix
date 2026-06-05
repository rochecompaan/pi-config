{ pkgs }:

pkgs.buildNpmPackage {
  pname = "pi-intervals";
  version = "0.1.0-1edf5ba";

  src = pkgs.fetchFromGitHub {
    owner = "sixfeetup";
    repo = "pi-intervals";
    rev = "1edf5ba327066c2429f41564a2a4acc169fda336";
    hash = "sha256-Hna+VBQ+AwTEAqsWpMYyp7IFGus3S2eDxhGKZiKrePc=";
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
