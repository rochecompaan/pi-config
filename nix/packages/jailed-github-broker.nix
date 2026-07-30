{
  pkgs,
  hostGh ? pkgs.gh,
  hostSsh ? pkgs.openssh,
}:
let
  common = {
    version = "0.1.0";
    src = ../../packages/jailed-github-broker;
    vendorHash = null;
  };

  client = pkgs.buildGoModule (
    common
    // {
      pname = "jailed-github-broker-client";
      ldflags = [
        "-s"
        "-w"
        "-X main.hostGHExecutable="
        "-X main.hostSSHExecutable="
      ];
      postInstall = ''
        mv "$out/bin/jailed-github-broker" "$out/bin/.jailed-github-broker-client"
        ln -s .jailed-github-broker-client "$out/bin/gh"
        ln -s .jailed-github-broker-client "$out/bin/jailed-git-ssh"
      '';
      meta = {
        description = "Jail-side clients for the jailed GitHub broker";
        license = pkgs.lib.licenses.mit;
      };
    }
  );
in
pkgs.buildGoModule (
  common
  // {
    pname = "jailed-github-broker";

    ldflags = [
      "-s"
      "-w"
      "-X main.hostGHExecutable=${hostGh}/bin/gh"
      "-X main.hostSSHExecutable=${hostSsh}/bin/ssh"
    ];

    postInstall = ''
      ln -s jailed-github-broker "$out/bin/gh"
      ln -s jailed-github-broker "$out/bin/jailed-git-ssh"
    '';

    passthru = { inherit client; };

    meta = {
      description = "Policy-enforcing GitHub broker for jailed Pi environments";
      license = pkgs.lib.licenses.mit;
      mainProgram = "jailed-github-broker";
    };
  }
)
