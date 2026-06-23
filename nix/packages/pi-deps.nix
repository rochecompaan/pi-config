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
      url = "https://registry.npmjs.org/sherpa-onnx-node/-/sherpa-onnx-node-1.13.0.tgz";
      hash = "sha256-YV+px436CmhSDmshUmOLWTaeoqp+miY69TqHJpMwPkA=";
    };

    sherpaOnnxLinuxX64 = pkgs.fetchzip {
      url = "https://registry.npmjs.org/sherpa-onnx-linux-x64/-/sherpa-onnx-linux-x64-1.13.0.tgz";
      hash = "sha256-w1SfJmebP8inl1z/sd0qaC1wL/KYDmnzD/NiDCde3gY=";
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

    piSubagentsSrc = pkgs.fetchgit {
      url = "https://github.com/nicobailon/pi-subagents.git";
      rev = "0b3f5b4d16557228cf7ce3e2de7b708f94ccf9ac";
      sha256 = "sha256-OOepzpERAz1E7yIl85IxcXs+QFUzi6uhpC6RjQXr1Yc=";
    };

    piSubagents = pkgs.buildNpmPackage {
      pname = "pi-subagents";
      version = "0.23.0";
      src = piSubagentsSrc;

      npmDepsHash = "sha256-hJwe6crzgVnosyJcfV5BIu0cfm69kEQ1vaZNteQxoY4=";

      dontNpmBuild = true;
    };

    superpowersSrc = pkgs.fetchgit {
      url = "https://github.com/obra/superpowers.git";
      rev = "e7a2d16476bf042e9add4699c9d018a90f86e4a6";
      sha256 = "sha256-8/M/S0BUYurZkFqe6LemVtBQnPSxBNfy1C7Q6f92hjE=";
    };

    diffPackageSrc = pkgs.fetchurl {
      url = "https://registry.npmjs.org/diff/-/diff-7.0.0.tgz";
      sha256 = "sha256-kRLnmAa9a+V4p6bxJNlnEdQGCwus1NS6xOlq59CPKsE=";
    };

    diffPackage = pkgs.runCommand "diff-npm" { } ''
      mkdir -p $out/lib/node_modules/diff
      cd $out/lib/node_modules/diff
      ${pkgs.gnutar}/bin/tar -xzf ${diffPackageSrc} --strip-components=1
    '';

    contextModeSrc = pkgs.fetchurl {
      url = "https://registry.npmjs.org/context-mode/-/context-mode-1.0.166.tgz";
      hash = "sha256-lmx1iIcEsmcOEE01OYu8pFhhDrIdyk03w7Dc2Ldlj9M=";
    };

    contextMode = pkgs.buildNpmPackage {
      pname = "context-mode";
      version = "1.0.166";
      src = contextModeSrc;

      npmDepsHash = "sha256-T04kruce0Ghu9WN+aDnwX6Q79Au9p4TtHI3OvcHLcbA=";

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
      piRemote
      piSubagents
      superpowersSrc
      ;

    packagePaths = [
      "${contextMode}/lib/node_modules/context-mode"
      "${piListen}"
      "${piMessengerBridge}/lib/node_modules/pi-messenger-bridge"
      "${piRemote}/lib/node_modules/@noahsaso/pi-remote"
      "${piSubagents}/lib/node_modules/pi-subagents"
      "${superpowersSrc}"
    ];

    nodeModulePaths = {
      diff = "${diffPackage}/lib/node_modules/diff";
    };
  }
