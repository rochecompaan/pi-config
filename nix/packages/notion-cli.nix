{ pkgs }:
pkgs.buildGoModule rec {
  pname = "notion-cli";
  version = "0.7.0";

  # The upstream GitHub repository is no longer available. The Go module proxy
  # retains the published source, including the upstream tests.
  src = pkgs.fetchurl {
    url = "https://proxy.golang.org/github.com/4ier/notion-cli/@v/v${version}.zip";
    hash = "sha256-tUKoGLj734Qv44IrluRHRj807I2vFiJ9mKaFu0wO5Us=";
  };

  nativeBuildInputs = [ pkgs.unzip ];
  sourceRoot = "github.com/4ier/notion-cli@v${version}";

  vendorHash = "sha256-l+js7rA49aDVu6sHcuNDSv8R8E/Fi1J7yE17uaKHhjQ=";

  ldflags = [
    "-s"
    "-w"
    "-X github.com/4ier/notion-cli/cmd.Version=${version}"
  ];

  postInstall = ''
    mv "$out/bin/notion-cli" "$out/bin/notion"
  '';

  meta = {
    description = "Full-featured CLI for Notion";
    homepage = "https://github.com/4ier/notion-cli";
    license = pkgs.lib.licenses.mit;
    mainProgram = "notion";
  };
}
