{
  pkgs,
  src,
  pin,
}:
pkgs.buildNpmPackage {
  pname = "pi-voice";
  inherit src;
  inherit (pin) version npmDepsHash;

  nativeBuildInputs = [ pkgs.autoPatchelfHook ];
  buildInputs = [
    pkgs.stdenv.cc.cc.lib
    pkgs.alsa-lib
    pkgs.vulkan-loader
  ];

  # The recorder loads its PulseAudio backend with dlopen.
  appendRunpaths = [ "${pkgs.libpulseaudio}/lib" ];

  dontNpmBuild = true;
  makeCacheWritable = true;
  # Pi provides host peers; do not install another Pi alongside the extension.
  npmInstallFlags = [
    "--omit=dev"
    "--omit=peer"
  ];
  npmPruneFlags = [
    "--omit=dev"
    "--omit=peer"
  ];

  postInstall = ''
    # Koffi ships both glibc and musl binaries; Nix uses only the glibc variant.
    rm -rf "$out/lib/node_modules/@earendil-works/pi-voice/node_modules/@koromix"/koffi-linux-*/musl_*
  '';

  postPatch = ''
    cp ${./pi-voice-package-lock.json} package-lock.json

    # File transcription must also work on a minimal runtime PATH.
    # Keep both upstream environment overrides ahead of the packaged fallback.
    substituteInPlace src/file-audio.ts \
      --replace-fail 'return { executable: "ffmpeg" };' \
        'return { executable: "${pkgs.ffmpeg-headless}/bin/ffmpeg" };'
  '';
}
