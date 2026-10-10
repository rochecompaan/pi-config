{
  pkgs,
  src,
  pin,
}:
pkgs.buildNpmPackage {
  pname = "rpiv-voice";
  inherit src;
  inherit (pin) version npmDepsHash;

  nativeBuildInputs = [ pkgs.autoPatchelfHook ];
  buildInputs = [
    pkgs.stdenv.cc.cc.lib
    pkgs.alsa-lib
  ];

  # runtimeDependencies only patches executables; Node addons need this runpath.
  # Decibri loads its PulseAudio backend with dlopen.
  appendRunpaths = [ "${pkgs.libpulseaudio}/lib" ];

  dontNpmBuild = true;
  makeCacheWritable = true;
  # Pi provides host peers; the optional i18n peer is not part of this package.
  npmInstallFlags = [
    "--omit=dev"
    "--omit=peer"
  ];
  npmPruneFlags = [
    "--omit=dev"
    "--omit=peer"
  ];

  postPatch = ''
    cp ${./rpiv-voice-package-lock.json} package-lock.json

    # The first model download must also extract on a minimal runtime PATH.
    substituteInPlace audio/model-download.ts \
      --replace-fail 'const TAR_BIN = "tar";' \
        'const TAR_BIN = "${pkgs.gnutar}/bin/tar";' \
      --replace-fail '["-xjf"]' \
        '["--use-compress-program=${pkgs.bzip2}/bin/bzip2", "-xf"]'
  '';
}
