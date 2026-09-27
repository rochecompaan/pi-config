{ pkgs, upstreamPi }:

upstreamPi.overrideAttrs (oldAttrs: {
  patches = (oldAttrs.patches or [ ]) ++ [ ./pi-tool-result-preview-dist.patch ];

  nativeCheckInputs = (oldAttrs.nativeCheckInputs or [ ]) ++ [ pkgs.nodejs ];
  doCheck = true;
  checkPhase = ''
    runHook preCheck
    PI_PACKAGE_ROOT="$PWD" \
      ${pkgs.nodejs}/bin/node --test ${./pi-tool-result-preview.test.mjs}
    runHook postCheck
  '';
})
