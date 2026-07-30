{ lib, pkgs }:
let
  knownCapabilities = [
    "repository:read"
    "issues:read"
    "issues:write"
    "pull-requests:read"
    "pull-requests:write"
    "actions:read"
    "statuses:read"
    "git:read"
    "git:write"
  ];

  stableSocketPath = "/run/jailed-github-broker/broker.sock";
  maxStreamFrameBytes = 1048576;

  defaults = {
    enable = false;
    repository = "";
    capabilities = [ ];
    pushPolicy = {
      denyRefs = [ "refs/heads/main" ];
      denyDeletes = false;
      maxRefUpdates = null;
    };
    limits = {
      maxConcurrentRequests = 8;
      maxControlBytes = 1048576;
      maxStreamFrameBytes = 65536;
      maxPushPrefixBytes = 1048576;
      initialFrameTimeoutSeconds = 5;
      operationTimeoutSeconds = 600;
      idleStreamTimeoutSeconds = 120;
    };
  };

  unknownFields = known: value: lib.subtractLists known (lib.attrNames value);
  unique = values: builtins.length values == builtins.length (lib.unique values);
  strings = values: builtins.isList values && lib.all builtins.isString values;
  positive = value: builtins.isInt value && value > 0;

  validRepository =
    repository:
    let
      match = builtins.match "([^/]+)/([^/]+)" repository;
      owner = if match == null then "" else builtins.elemAt match 0;
      name = if match == null then "" else builtins.elemAt match 1;
    in
    match != null
    && builtins.stringLength owner <= 39
    && builtins.stringLength name <= 100
    && builtins.match "[A-Za-z0-9]([A-Za-z0-9]|-[A-Za-z0-9])*" owner != null
    && builtins.match "[A-Za-z0-9._-]+" name != null
    && name != "."
    && name != "..";

  validRef =
    ref:
    let
      components = lib.splitString "/" ref;
      validComponent =
        component: component != "" && !lib.hasPrefix "." component && !lib.hasSuffix ".lock" component;
      forbidden = [
        " "
        "~"
        "^"
        ":"
        "?"
        "*"
        "["
        "\\"
        "\t"
        "\n"
        "\r"
      ];
    in
    lib.hasPrefix "refs/" ref
    && !lib.hasInfix ".." ref
    && !lib.hasInfix "//" ref
    && !lib.hasInfix "@{" ref
    && !lib.hasSuffix "." ref
    && builtins.match ".*[[:cntrl:]].*" ref == null
    && lib.all (character: !lib.hasInfix character ref) forbidden
    && lib.all validComponent components;

  mkSubmoduleType =
    with lib;
    types.submodule {
      options = {
        enable = mkEnableOption "the host-side jailed GitHub broker";

        repository = mkOption {
          type = types.addCheck types.str (value: value == "" || validRepository value);
          default = "";
          description = "Literal GitHub owner/repository slug governed by the broker.";
        };

        capabilities = mkOption {
          type = types.listOf (types.enum knownCapabilities);
          default = [ ];
          description = "Broker operations authorized for the configured repository.";
        };

        pushPolicy = {
          denyRefs = mkOption {
            type = types.listOf (types.addCheck types.str validRef);
            default = defaults.pushPolicy.denyRefs;
            description = "Exact Git refs rejected by receive-pack.";
          };

          denyDeletes = mkOption {
            type = types.bool;
            default = false;
            description = "Whether receive-pack rejects ref deletions.";
          };

          maxRefUpdates = mkOption {
            type = types.nullOr types.ints.positive;
            default = null;
            description = "Optional maximum number of updates in one push.";
          };
        };

        limits = mapAttrs (
          _: default:
          mkOption {
            type = types.ints.positive;
            inherit default;
          }
        ) defaults.limits;
      };
    };

  normalize =
    value:
    assert lib.assertMsg (builtins.isAttrs value) "githubBroker must be an attribute set";
    let
      topUnknown = unknownFields [
        "enable"
        "repository"
        "capabilities"
        "pushPolicy"
        "limits"
      ] value;
      pushValue = value.pushPolicy or { };
      limitsValue = value.limits or { };
      normalized = {
        enable = value.enable or defaults.enable;
        repository = value.repository or defaults.repository;
        capabilities = value.capabilities or defaults.capabilities;
        pushPolicy = defaults.pushPolicy // pushValue;
        limits = defaults.limits // limitsValue;
      };
      capabilities = normalized.capabilities;
      policy = normalized.pushPolicy;
      limits = normalized.limits;
    in
    assert lib.assertMsg (
      topUnknown == [ ]
    ) "githubBroker contains unknown fields: ${lib.concatStringsSep ", " topUnknown}";
    assert lib.assertMsg (builtins.isAttrs pushValue)
      "githubBroker.pushPolicy must be an attribute set";
    assert lib.assertMsg (builtins.isAttrs limitsValue) "githubBroker.limits must be an attribute set";
    assert lib.assertMsg (
      unknownFields [ "denyRefs" "denyDeletes" "maxRefUpdates" ] pushValue == [ ]
    ) "githubBroker.pushPolicy contains unknown fields";
    assert lib.assertMsg (
      unknownFields (lib.attrNames defaults.limits) limitsValue == [ ]
    ) "githubBroker.limits contains unknown fields";
    assert lib.assertMsg (builtins.isBool normalized.enable) "githubBroker.enable must be a boolean";
    assert lib.assertMsg (builtins.isString normalized.repository)
      "githubBroker.repository must be a string";
    assert lib.assertMsg (
      !normalized.enable || validRepository normalized.repository
    ) "githubBroker.repository is required and must be a literal owner/repository slug when enabled";
    assert lib.assertMsg (
      normalized.repository == "" || validRepository normalized.repository
    ) "githubBroker.repository must be a literal owner/repository slug";
    assert lib.assertMsg (strings capabilities) "githubBroker.capabilities must be a list of strings";
    assert lib.assertMsg (lib.all (
      capability: builtins.elem capability knownCapabilities
    ) capabilities) "githubBroker.capabilities contains an unknown capability";
    assert lib.assertMsg (unique capabilities) "githubBroker.capabilities must not contain duplicates";
    assert lib.assertMsg (
      !builtins.elem "git:write" capabilities || builtins.elem "git:read" capabilities
    ) "githubBroker git:write requires git:read";
    assert lib.assertMsg (
      strings policy.denyRefs && lib.all validRef policy.denyRefs
    ) "githubBroker.pushPolicy.denyRefs must contain valid full Git refs";
    assert lib.assertMsg (unique policy.denyRefs)
      "githubBroker.pushPolicy.denyRefs must not contain duplicates";
    assert lib.assertMsg (builtins.isBool policy.denyDeletes)
      "githubBroker.pushPolicy.denyDeletes must be a boolean";
    assert lib.assertMsg (
      policy.maxRefUpdates == null || positive policy.maxRefUpdates
    ) "githubBroker.pushPolicy.maxRefUpdates must be null or positive";
    assert lib.assertMsg (lib.all positive (
      lib.attrValues limits
    )) "all githubBroker limits must be positive integers";
    assert lib.assertMsg (limits.maxStreamFrameBytes <= maxStreamFrameBytes)
      "githubBroker.limits.maxStreamFrameBytes exceeds the practical maximum of ${toString maxStreamFrameBytes}";
    builtins.deepSeq normalized normalized;

  mkConfigFile =
    value: pkgs.writeText "jailed-github-broker.json" (builtins.toJSON (normalize value));

  lifecycleLib = import ./jailed-github-broker-lifecycle.nix {
    inherit lib pkgs;
  };

in
{
  inherit (lifecycleLib) hostSocketEnvironment lifecycleRuntimeInputs mkLifecycleScript;
  inherit
    defaults
    knownCapabilities
    maxStreamFrameBytes
    mkConfigFile
    mkSubmoduleType
    normalize
    stableSocketPath
    validRef
    validRepository
    ;
}
