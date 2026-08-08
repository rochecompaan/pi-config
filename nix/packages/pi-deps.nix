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
      url = "https://registry.npmjs.org/sherpa-onnx-node/-/sherpa-onnx-node-1.13.4.tgz";
      hash = "sha256-cbdaglSWW0PFQALKrjKXbUQTQJ7ddFDW+7Nuhi0zmBg=";
    };

    sherpaOnnxLinuxX64 = pkgs.fetchzip {
      url = "https://registry.npmjs.org/sherpa-onnx-linux-x64/-/sherpa-onnx-linux-x64-1.13.4.tgz";
      hash = "sha256-yWtsF6+H770ZiTFFJUsGvtE7r4Pr1t2dFMT2DP1aeV8=";
    };

    piListen =
      pkgs.runCommand "pi-listen-7.2.2"
        {
          nativeBuildInputs = [ pkgs.autoPatchelfHook ];
          buildInputs = [ pkgs.stdenv.cc.cc.lib ];
        }
        ''
          mkdir -p $out/node_modules
          cp -r ${piListenSrc}/. $out/
          cp -r ${sherpaOnnxNode} $out/node_modules/sherpa-onnx-node
          cp -r ${sherpaOnnxLinuxX64} $out/node_modules/sherpa-onnx-linux-x64
          chmod -R u+w $out/node_modules/sherpa-onnx-linux-x64
          autoPatchelf $out/node_modules/sherpa-onnx-linux-x64
        '';

    piVimPackageLock = ./pi-vim-package-lock.json;

    piVimSrc = pkgs.fetchzip {
      url = "https://registry.npmjs.org/pi-vim/-/pi-vim-0.14.1.tgz";
      hash = "sha256-2Mv39IBm/vIKTYIa5g/RpQmlJ+O3aabY4KbRf5VPvF0=";
    };

    piVim = pkgs.buildNpmPackage {
      pname = "pi-vim";
      version = "0.14.1";
      src = piVimSrc;

      npmDepsHash = "sha256-6BI/fEQ2C6U/oip1fNh+7HG6UfeXNHmlpIQDKi1TmaI=";

      dontNpmBuild = true;
      makeCacheWritable = true;
      npmInstallFlags = [ "--omit=dev" ];

      postPatch = ''
        cp ${piVimPackageLock} package-lock.json
      '';
    };

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
      rev = "v0.34.0";
      sha256 = "sha256-RN8f5cT/oRSkqwOAmvJ2uJsOmScYb0ijwixTd75iGHk=";
    };

    piSubagents = pkgs.buildNpmPackage {
      pname = "pi-subagents";
      version = "0.34.0";
      src = piSubagentsSrc;

      npmDepsHash = "sha256-IJJ3hceNvHUr5QFIa/+0tnxNiEPh7jifE9dvPHrLE58=";

      dontNpmBuild = true;
    };

    superpowersSrc = pkgs.fetchgit {
      url = "https://github.com/obra/superpowers.git";
      rev = "v6.2.0";
      sha256 = "sha256-F5LEk0yNWbMpan1vZSFZM76XSpsFGvA7h8q6Idrvenk=";
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

    piCodegraph = pkgs.fetchzip {
      name = "pi-codegraph-0.1.10";
      url = "https://registry.npmjs.org/@vndv/pi-codegraph/-/pi-codegraph-0.1.10.tgz";
      hash = "sha256-QV7TBdbzuZwdNNAffOqeoXRVKjeJumpNF4S57KzAGmU=";
    };

    codegraphShimSrc = pkgs.fetchzip {
      name = "codegraph-shim-1.5.0";
      url = "https://registry.npmjs.org/@colbymchenry/codegraph/-/codegraph-1.5.0.tgz";
      hash = "sha256-ZHTn1NdPp+gaTYKChscEMYr+maUwdAqzyKguUfwBXG4=";
    };

    codegraphLinuxX64Src = pkgs.fetchzip {
      name = "codegraph-linux-x64-1.5.0";
      url = "https://registry.npmjs.org/@colbymchenry/codegraph-linux-x64/-/codegraph-linux-x64-1.5.0.tgz";
      hash = "sha256-jueJv5/6tw8MeL4fKwEz6hTjLJ9IrxzrZmoPELA5v0Y=";
    };

    # The npm thin installer (npm-shim.js) resolves the platform bundle as a
    # sibling package under the same @colbymchenry scope via require.resolve,
    # then execs the bundle's launcher, which runs the vendored Node 24 binary.
    # CODEGRAPH_NO_DOWNLOAD keeps the shim's network self-heal fallback off so
    # the CLI stays fully store-resolved.
    codegraphCli =
      pkgs.runCommand "codegraph-1.5.0"
        {
          nativeBuildInputs = [ pkgs.autoPatchelfHook ];
          buildInputs = [ pkgs.stdenv.cc.cc.lib ];
        }
        ''
          mkdir -p $out/lib/node_modules/@colbymchenry/codegraph
          cp -r ${codegraphShimSrc}/. $out/lib/node_modules/@colbymchenry/codegraph/
          cp -r ${codegraphLinuxX64Src} $out/lib/node_modules/@colbymchenry/codegraph-linux-x64
          chmod -R u+w $out/lib/node_modules/@colbymchenry/codegraph-linux-x64
          chmod +x $out/lib/node_modules/@colbymchenry/codegraph-linux-x64/bin/codegraph
          chmod +x $out/lib/node_modules/@colbymchenry/codegraph-linux-x64/node
          autoPatchelf $out/lib/node_modules/@colbymchenry/codegraph-linux-x64

          mkdir -p $out/bin
          cat > $out/bin/codegraph <<EOF
          #!${pkgs.runtimeShell}
          export CODEGRAPH_NO_DOWNLOAD=1
          exec ${pkgs.nodejs}/bin/node $out/lib/node_modules/@colbymchenry/codegraph/npm-shim.js "\$@"
          EOF
          chmod +x $out/bin/codegraph
        '';

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
      codegraphCli
      contextMode
      diffPackage
      piCodegraph
      piListen
      piMessengerBridge
      piRemote
      piSubagents
      piVim
      superpowersSrc
      ;

    packagePaths = [
      "${contextMode}/lib/node_modules/context-mode"
      "${piCodegraph}"
      "${piListen}"
      "${piRemote}/lib/node_modules/@noahsaso/pi-remote"
      "${piSubagents}/lib/node_modules/pi-subagents"
      "${piVim}/lib/node_modules/pi-vim"
      "${superpowersSrc}"
    ];

    nodeModulePaths = {
      diff = "${diffPackage}/lib/node_modules/diff";
    };
  }
