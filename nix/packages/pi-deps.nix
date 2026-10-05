{ pkgs, piRemote }:
if pkgs.stdenv.hostPlatform.system != "x86_64-linux" then
  throw "pi-deps only supports x86_64-linux because bundled native artifacts are linux-x64"
else
  let
    pins = builtins.fromJSON (builtins.readFile ../dependency-pins.json);

    # dependency-source: pi-listen
    piListenSrc = pkgs.fetchzip {
      inherit (pins."pi-listen") url hash;
    };

    # dependency-source: sherpa-onnx-node
    sherpaOnnxNode = pkgs.fetchzip {
      inherit (pins."sherpa-onnx-node") url hash;
    };

    # dependency-source: sherpa-onnx-linux-x64
    sherpaOnnxLinuxX64 = pkgs.fetchzip {
      inherit (pins."sherpa-onnx-linux-x64") url hash;
    };

    piListen =
      pkgs.runCommand "pi-listen-${pins."pi-listen".version}"
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

    # dependency-source: pi-loadout
    piLoadoutSrc = pkgs.fetchzip {
      name = "pi-loadout-${pins."pi-loadout".version}";
      inherit (pins."pi-loadout") url hash;
    };

    piLoadout = pkgs.applyPatches {
      name = "pi-loadout-${pins."pi-loadout".version}";
      src = piLoadoutSrc;
      patches = [
        ../../patches/pi-loadout-startup-selection.patch
        ../../patches/pi-loadout-managed-files.patch
      ];
    };

    piVimPackageLock = ./pi-vim-package-lock.json;

    # dependency-source: pi-vim
    piVimSrc = pkgs.fetchzip {
      inherit (pins."pi-vim") url hash;
    };

    piVim = pkgs.buildNpmPackage {
      pname = "pi-vim";
      inherit (pins."pi-vim") version;
      src = piVimSrc;

      inherit (pins."pi-vim") npmDepsHash;

      dontNpmBuild = true;
      makeCacheWritable = true;
      npmInstallFlags = [ "--omit=dev" ];

      postPatch = ''
        cp ${piVimPackageLock} package-lock.json
      '';
    };

    piClaudeBridgePatch = ./pi-claude-bridge-safe-history-reconstruction.patch;
    # Applied after piClaudeBridgePatch. Resume Claude Code's session only while
    # pi's history still starts with the messages it holds, so context paging
    # (which drops older messages) forces a rebuild instead of a stale resume.
    piClaudeBridgePagingHistorySyncPatch = ./pi-claude-bridge-paging-history-sync.patch;
    piClaudeBridgeActivePagingPatch = ./pi-claude-bridge-active-paging.patch;
    piClaudeBridgeActivePagingTest = ./pi-claude-bridge-active-paging.test.mjs;
    piClaudeBridgeProviderHarness = ./pi-claude-bridge-provider-harness.mjs;
    # main's package-lock.json omits integrity for five nested dev-only
    # @earendil-works entries, which crashes the npm-deps fetcher
    # ("non-git dependencies should have associated integrity"). Add them back.
    piClaudeBridgeLockIntegrityPatch = ./pi-claude-bridge-lock-integrity.patch;
    piClaudeBridgeHistoryReconstructionTest = ./pi-claude-bridge-history-reconstruction.test.mjs;
    piClaudeBridgeDirectCompletionTest = ./pi-claude-bridge-direct-completion.test.mjs;
    piClaudeBridgeHistoryIdentityTest = ./pi-claude-bridge-history-identity.test.mjs;

    # GitHub main snapshot (unreleased): adds Pi 0.87 compatibility and
    # claude-opus-5-5 with its measured 1M context window.
    # dependency-source: pi-claude-bridge
    piClaudeBridgeSrc = pkgs.fetchFromGitHub {
      owner = "elidickinson";
      repo = "pi-claude-bridge";
      inherit (pins."pi-claude-bridge") rev hash;
    };

    piClaudeBridge = pkgs.buildNpmPackage {
      pname = "pi-claude-bridge";
      inherit (pins."pi-claude-bridge") version;
      src = piClaudeBridgeSrc;

      nativeBuildInputs = [ pkgs.autoPatchelfHook ];
      buildInputs = [ pkgs.stdenv.cc.cc.lib ];

      inherit (pins."pi-claude-bridge") npmDepsHash;

      dontNpmBuild = true;
      makeCacheWritable = true;
      npmInstallFlags = [
        "--omit=dev"
        "--omit=peer"
      ];

      postPatch = ''
        patch -p1 < ${piClaudeBridgeLockIntegrityPatch}
        patch -p1 < ${piClaudeBridgePatch}
        patch -p1 < ${piClaudeBridgePagingHistorySyncPatch}
        patch -p1 < ${piClaudeBridgeActivePagingPatch}
      '';

      doInstallCheck = true;
      installCheckPhase = ''
        claude="$out/lib/node_modules/pi-claude-bridge/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude"
        claudeVersion="$("$claude" --version)" || exit $?
        test "$claudeVersion" = "2.1.280 (Claude Code)"
        bridgeHistoryModule="$TMPDIR/history-reconstruction.ts"
        bridgeDirectCompletionModule="$TMPDIR/request-router.ts"
        bridgeHistoryIdentityModule="$TMPDIR/history-identity.ts"
        cp "$out/lib/node_modules/pi-claude-bridge/src/history-reconstruction.ts" "$bridgeHistoryModule"
        cp "$out/lib/node_modules/pi-claude-bridge/src/request-router.ts" "$bridgeDirectCompletionModule"
        cp "$out/lib/node_modules/pi-claude-bridge/src/history-identity.ts" "$bridgeHistoryIdentityModule"
        BRIDGE_HISTORY_MODULE="$bridgeHistoryModule" \
          BRIDGE_DIRECT_COMPLETION_MODULE="$bridgeDirectCompletionModule" \
          BRIDGE_HISTORY_IDENTITY_MODULE="$bridgeHistoryIdentityModule" \
          ${pkgs.nodejs}/bin/node --test --experimental-strip-types \
          ${piClaudeBridgeHistoryReconstructionTest} \
          ${piClaudeBridgeDirectCompletionTest} \
          ${piClaudeBridgeHistoryIdentityTest}
        mkdir -p "$TMPDIR/bridge-provider-tests"
        cp ${piClaudeBridgeActivePagingTest} "$TMPDIR/bridge-provider-tests/pi-claude-bridge-active-paging.test.mjs"
        cp ${piClaudeBridgeProviderHarness} "$TMPDIR/bridge-provider-tests/pi-claude-bridge-provider-harness.mjs"
        BRIDGE_PROVIDER_MODULE="$out/lib/node_modules/pi-claude-bridge/src/index.ts" \
          ${pkgs.nodejs}/bin/node --test \
          "$TMPDIR/bridge-provider-tests/pi-claude-bridge-active-paging.test.mjs"
      '';
    };

    # dependency-source: pi-subagents
    piSubagentsSrc = pkgs.fetchgit {
      url = "https://github.com/nicobailon/pi-subagents.git";
      inherit (pins."pi-subagents") rev sha256;
    };

    piSubagents = pkgs.buildNpmPackage {
      pname = "pi-subagents";
      inherit (pins."pi-subagents") version;
      src = piSubagentsSrc;

      inherit (pins."pi-subagents") npmDepsHash;

      dontNpmBuild = true;
      npmInstallFlags = [
        "--omit=dev"
        "--omit=peer"
      ];
    };

    # dependency-source: remote-pi-extension
    remotePiExtensionSrc = pkgs.fetchzip {
      inherit (pins."remote-pi-extension") url hash;
    };

    remotePiExtension = pkgs.buildNpmPackage {
      pname = "remote-pi";
      inherit (pins."remote-pi-extension") version;
      src = remotePiExtensionSrc;

      # Keep its shared CLI entry usable without Pi's extension-only modules.
      patches = [ ../../patches/remote-pi-host-imports.patch ];

      inherit (pins."remote-pi-extension") npmDepsHash;

      dontNpmBuild = true;
      makeCacheWritable = true;
      npmInstallFlags = [ "--omit=dev" ];

      postPatch = ''
        cp ${./remote-pi-package-lock.json} package-lock.json
      '';

      postInstall = ''
        rm -rf "$out/bin"

        # Temporary until remote-pi declares host modules as peers upstream.
        # Patch after npm installation to keep the upstream lockfile unchanged.
        ${pkgs.nodejs}/bin/node <<'NODE'
        const fs = require("node:fs");
        const path = require("node:path");
        const packageRoot = path.join(process.env.out, "lib/node_modules/remote-pi");
        const manifestPath = path.join(packageRoot, "package.json");
        const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
        const hostPackages = [
          "@earendil-works/pi-ai",
          "@earendil-works/pi-agent-core",
          "@earendil-works/pi-coding-agent",
          "@earendil-works/pi-tui",
          "typebox",
        ];
        for (const name of hostPackages) {
          if (Object.hasOwn(manifest.dependencies, name)) {
            delete manifest.dependencies[name];
            manifest.peerDependencies ??= {};
            manifest.peerDependencies[name] = "*";
          }
          fs.rmSync(path.join(packageRoot, "node_modules", name), {
            recursive: true,
            force: true,
          });
        }
        fs.rmSync(path.join(packageRoot, "node_modules/.bin/pi"), { force: true });
        fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
        NODE
      '';
    };

    # dependency-source: simple-english
    simpleEnglishSrc = pkgs.fetchgit {
      url = "https://github.com/AminBlg/SimpleEnglish.git";
      inherit (pins."simple-english") rev sha256;
    };

    # dependency-source: superpowers
    superpowersSrc = pkgs.fetchgit {
      url = "https://github.com/obra/superpowers.git";
      inherit (pins.superpowers) rev sha256;
    };

    superpowers = pkgs.applyPatches {
      name = "superpowers";
      src = superpowersSrc;
      patches = [ ../../patches/superpowers-loadout-bootstrap.patch ];
    };

    # dependency-source: mattpocock-skills
    mattPocockSkillsSrc = pkgs.fetchgit {
      url = "https://github.com/mattpocock/skills.git";
      inherit (pins."mattpocock-skills") rev sha256;
    };

    mattPocockSkills = pkgs.runCommand "mattpocock-skills" { } ''
      mkdir -p "$out/skills"
      cp -r ${mattPocockSkillsSrc}/skills/engineering "$out/skills/engineering"
      cp -r ${mattPocockSkillsSrc}/skills/productivity "$out/skills/productivity"
    '';

    # dependency-source: diff
    diffPackageSrc = pkgs.fetchurl {
      inherit (pins.diff) url sha256;
    };

    diffPackage = pkgs.runCommand "diff-npm" { } ''
      mkdir -p $out/lib/node_modules/diff
      cd $out/lib/node_modules/diff
      ${pkgs.gnutar}/bin/tar -xzf ${diffPackageSrc} --strip-components=1
    '';

    # dependency-source: context-mode
    contextModeSrc = pkgs.fetchurl {
      inherit (pins."context-mode") url hash;
    };

    # dependency-source: pi-codegraph
    piCodegraph = pkgs.fetchzip {
      name = "pi-codegraph-${pins."pi-codegraph".version}";
      inherit (pins."pi-codegraph") url hash;
    };

    # dependency-source: pi-context-paging
    piContextPaging = pkgs.fetchzip {
      name = "pi-context-paging-${pins."pi-context-paging".version}";
      inherit (pins."pi-context-paging") url hash;
    };

    # dependency-source: codegraph
    codegraphShimSrc = pkgs.fetchzip {
      name = "codegraph-shim-${pins.codegraph.version}";
      inherit (pins.codegraph) url hash;
    };

    # dependency-source: codegraph-linux-x64
    codegraphLinuxX64Src = pkgs.fetchzip {
      name = "codegraph-linux-x64-${pins."codegraph-linux-x64".version}";
      inherit (pins."codegraph-linux-x64") url hash;
    };

    # The npm thin installer (npm-shim.js) resolves the platform bundle as a
    # sibling package under the same @colbymchenry scope via require.resolve,
    # then execs the bundle's launcher, which runs the vendored Node 24 binary.
    # CODEGRAPH_NO_DOWNLOAD keeps the shim's network self-heal fallback off so
    # the CLI stays fully store-resolved.
    codegraphCli =
      pkgs.runCommand "codegraph-${pins.codegraph.version}"
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
      inherit (pins."context-mode") version;
      src = contextModeSrc;

      inherit (pins."context-mode") npmDepsHash;

      dontNpmBuild = true;
      makeCacheWritable = true;
      npmInstallFlags = [ "--omit=dev" ];

      postPatch = ''
        cp ${../../context-mode-package-lock.json} package-lock.json

        # The Pi adapter runs inside Pi's Bun executable and spawns its MCP
        # server through a runtime discovered on PATH. Pin that child to the
        # Node runtime used to build better-sqlite3 so their ABIs stay aligned.
        substituteInPlace build/adapters/pi/mcp-bridge.js \
          --replace-fail \
            'const detect = deps.detect ?? (() => detectRuntimes());' \
            'const detect = deps.detect ?? (() => ({ javascript: "${pkgs.nodejs}/bin/node" }));'
      '';
    };
  in
  {
    inherit
      codegraphCli
      contextMode
      diffPackage
      mattPocockSkills
      mattPocockSkillsSrc
      piCodegraph
      piClaudeBridge
      piContextPaging
      piListen
      piLoadout
      piRemote
      piSubagents
      piVim
      remotePiExtension
      simpleEnglishSrc
      superpowers
      superpowersSrc
      ;

    # Packages load in this order, after auto-discovered extensions. Keep
    # context paging first so its context handler runs before other packages'.
    packagePaths = [
      "${piContextPaging}"
      "${contextMode}/lib/node_modules/context-mode"
      "${piClaudeBridge}/lib/node_modules/pi-claude-bridge"
      "${piCodegraph}"
      "${piListen}"
      "${piLoadout}"
      "${mattPocockSkills}"
      "${superpowers}"
      "${piRemote}/lib/node_modules/@noahsaso/pi-remote"
      "${piSubagents}/lib/node_modules/pi-subagents"
      "${piVim}/lib/node_modules/pi-vim"
      "${remotePiExtension}/lib/node_modules/remote-pi"
    ];

    nodeModulePaths = {
      diff = "${diffPackage}/lib/node_modules/diff";
    };
  }
