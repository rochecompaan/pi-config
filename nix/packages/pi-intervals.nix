{ pkgs }:

pkgs.buildNpmPackage {
  pname = "pi-intervals";
  version = "0.1.0-bd3b432";

  src = pkgs.fetchFromGitHub {
    owner = "sixfeetup";
    repo = "pi-intervals";
    rev = "bd3b4328e14246db55540328448560359ff14a2b";
    hash = "sha256-kUQYlIBMNhDC2US2i25Ll4rgants2YiYaJGIrGlOAI0=";
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
