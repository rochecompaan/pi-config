{ pkgs, piRemote }:
if pkgs.stdenv.hostPlatform.system != "x86_64-linux" then
  throw "pi-deps only supports x86_64-linux because bundled native artifacts are linux-x64"
else
  let
    piListenSrc = pkgs.fetchzip {
      url = "https://registry.npmjs.org/@codexstar/pi-listen/-/pi-listen-7.2.2.tgz";
      hash = "sha256-MbYQiwQMvXkN0dRYdMTTX+4whLjey/yGcke5zq6BRO0=";
    };

    sherpaOnnxNode = pkgs.fetchzip {
      url = "https://registry.npmjs.org/sherpa-onnx-node/-/sherpa-onnx-node-1.13.3.tgz";
      hash = "sha256-ybZ3MNNbQW/QSz1qSXggk7jrHaldCfXbu9p7f0/1DR4=";
    };

    sherpaOnnxLinuxX64 = pkgs.fetchzip {
      url = "https://registry.npmjs.org/sherpa-onnx-linux-x64/-/sherpa-onnx-linux-x64-1.13.3.tgz";
      hash = "sha256-6qNYH/QPMk1/7hghVLT9POmed39CqeI29QBqARtQ098=";
    };

    piListen = pkgs.runCommand "pi-listen-7.2.2" { } ''
      mkdir -p $out/node_modules
      cp -r ${piListenSrc}/. $out/
      cp -r ${sherpaOnnxNode} $out/node_modules/sherpa-onnx-node
      cp -r ${sherpaOnnxLinuxX64} $out/node_modules/sherpa-onnx-linux-x64
    '';

    matrixSdkCryptoNodeFile = "matrix-sdk-crypto.linux-x64-gnu.node";

    matrixSdkCryptoNode = pkgs.fetchurl {
      url = "https://github.com/matrix-org/matrix-rust-sdk-crypto-nodejs/releases/download/v0.4.0/matrix-sdk-crypto.linux-x64-gnu.node";
      hash = "sha256-cHjU3ZhxKPea/RksT2IfZK3s435D8qh1bx0KnwNN5xg=";
    };

    piMessengerBridgePackageLock = ./pi-messenger-bridge-package-lock.json;

    piMessengerBridgeSrc = pkgs.fetchzip {
      url = "https://registry.npmjs.org/pi-messenger-bridge/-/pi-messenger-bridge-0.4.0.tgz";
      hash = "sha256-sbI1Diu0Ii/zU9p5Ar0RnwQJ5hbr3BM1ShNNc85PFqs=";
    };

    piMessengerBridge = pkgs.buildNpmPackage {
      pname = "pi-messenger-bridge";
      version = "0.4.0";
      src = piMessengerBridgeSrc;

      npmDepsHash = "sha256-NoSzGuRXBu0ph2MpqC9bVx+/1FvG3Po/VsCQCyBPhT8=";

      dontNpmBuild = true;
      makeCacheWritable = true;

      postPatch = ''
        cp ${piMessengerBridgePackageLock} package-lock.json
      '';

      postInstall = ''
        install -Dm444 ${matrixSdkCryptoNode} \
          $out/lib/node_modules/pi-messenger-bridge/node_modules/@matrix-org/matrix-sdk-crypto-nodejs/${matrixSdkCryptoNodeFile}
      '';
    };

    piPonytail = pkgs.fetchzip {
      url = "https://registry.npmjs.org/pi-ponytail/-/pi-ponytail-0.1.2.tgz";
      hash = "sha256-ECZc+Zu0Gv7YvvrpbLp+H8oVrxZv0Gq0h/b4MvdvsHA=";
    };

    piSubagentsSrc = pkgs.fetchgit {
      url = "https://github.com/nicobailon/pi-subagents.git";
      rev = "e4f06282d0c95856b36b7ec2893f4fd294ebfefe";
      sha256 = "sha256-lvcf6VC6xfZ3j8oHpKoYPNQi8hKFLLhcQq5FxcjJaKk=";
    };

    piSubagents = pkgs.buildNpmPackage {
      pname = "pi-subagents";
      version = "0.31.0";
      src = piSubagentsSrc;

      npmDepsHash = "sha256-z57zpjsprtC0CPJbLukAwD9N/lOCHglMrC8Te7UWSgQ=";

      dontNpmBuild = true;
    };

    superpowersSrc = pkgs.fetchgit {
      url = "https://github.com/obra/superpowers.git";
      rev = "896224c4b1879920ab573417e68fd51d2ccc9072";
      sha256 = "sha256-+lT2a/qq0SF4k0PgnEDKiuidVlZX2p0vEso4d/5T1os=";
    };

    diffPackageSrc = pkgs.fetchurl {
      url = "https://registry.npmjs.org/diff/-/diff-9.0.0.tgz";
      sha256 = "sha256-uJi/I8lVlGB1duJd3UAT8dUe0OhiqvBzKBWDDIeztY8=";
    };

    diffPackage = pkgs.runCommand "diff-npm" { } ''
      mkdir -p $out/lib/node_modules/diff
      cd $out/lib/node_modules/diff
      ${pkgs.gnutar}/bin/tar -xzf ${diffPackageSrc} --strip-components=1
    '';

    contextModeSrc = pkgs.fetchurl {
      url = "https://registry.npmjs.org/context-mode/-/context-mode-1.0.169.tgz";
      hash = "sha256-CcQeTPd7IVZsdrjqL9vX89gjBV/uLwLCFm/Vu1ddryw=";
    };

    contextMode = pkgs.buildNpmPackage {
      pname = "context-mode";
      version = "1.0.169";
      src = contextModeSrc;

      npmDepsHash = "sha256-0e3oGyZMLYA8Li1rRxpmqTa222v0u7nK5+5cjSgZnrM=";

      dontNpmBuild = true;
      makeCacheWritable = true;
      npmInstallFlags = [ "--omit=dev" ];

      postPatch = ''
        cp ${../../context-mode-package-lock.json} package-lock.json
      '';
    };
  in
  {
    inherit
      contextMode
      diffPackage
      piListen
      piMessengerBridge
      piPonytail
      piRemote
      piSubagents
      superpowersSrc
      ;

    packagePaths = [
      "${contextMode}/lib/node_modules/context-mode"
      "${piListen}"
      "${piMessengerBridge}/lib/node_modules/pi-messenger-bridge"
      "${piPonytail}"
      "${piRemote}/lib/node_modules/@noahsaso/pi-remote"
      "${piSubagents}/lib/node_modules/pi-subagents"
      "${superpowersSrc}"
    ];

    nodeModulePaths = {
      diff = "${diffPackage}/lib/node_modules/diff";
    };
  }
