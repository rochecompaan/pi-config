{ pkgs, piConfig, piDeps }:
let
  selectedPiConfigSkills = map
    (name: "${piConfig}/skills/${name}")
    [
      "commit"
      "frontend-design"
      "github"
      "module-size"
      "nix-config"
      "simple-english"
    ];

  selectedMattPocockSkills = map
    (name: "${piDeps.mattPocockSkills}/skills/engineering/${name}")
    [
      "codebase-design"
      "domain-modeling"
    ];

  claudeSkills = selectedPiConfigSkills ++ selectedMattPocockSkills ++ [
    "${piDeps.superpowersSrc}/skills"
    "${piDeps.contextMode}/lib/node_modules/context-mode/skills"
  ];
in
pkgs.runCommand "roche-pi-den-bundle"
  {
    passthru.denResources = {
      pi.packages = [ piConfig ] ++ piDeps.packagePaths;
      claude = {
        skills = claudeSkills;
        mcpServers.context-mode = {
          command = "${piDeps.contextMode}/bin/context-mode";
          args = [ ];
        };
      };
    };
  }
  ''
    mkdir -p "$out"
  ''
