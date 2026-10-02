{ pkgs, upstreamPi }:

upstreamPi.overrideAttrs (oldAttrs: {
  patches = (oldAttrs.patches or [ ]) ++ [
    ./pi-tool-result-preview-dist.patch
    ./pi-auth-file-dist.patch
  ];

  nativeCheckInputs = (oldAttrs.nativeCheckInputs or [ ]) ++ [ pkgs.nodejs ];
  doCheck = true;
  checkPhase = ''
    runHook preCheck
    PI_PACKAGE_ROOT="$PWD" \
      ${pkgs.nodejs}/bin/node --test \
        ${./pi-tool-result-preview.test.mjs} \
        ${./pi-auth-file.test.mjs}
    runHook postCheck
  '';

  # The compiled binary must honor the auth file override, not only dist/.
  postInstallCheck = (oldAttrs.postInstallCheck or "") + ''
    auth_check=$(mktemp -d)
    mkdir -p "$auth_check/home/.pi/agent" "$auth_check/project"
    printf '%s' '{"openai":{"type":"api_key","key":"sk-global"}}' \
      > "$auth_check/home/.pi/agent/auth.json"
    printf '%s' '{"openai":{"type":"api_key","key":"sk-project"}}' \
      > "$auth_check/project/auth.json"
    project_key=$(
      HOME="$auth_check/home" PI_OFFLINE=1 \
        PI_CODING_AGENT_AUTH_FILE="$auth_check/project/auth.json" \
        "$out/bin/pi" auth print-api-key --provider openai
    )
    test "$project_key" = sk-project
  '';
})
