{ pkgs }:
pkgs.buildGoModule rec {
  pname = "notion-cli";
  version = "0.7.0";

  src = pkgs.fetchFromGitHub {
    owner = "4ier";
    repo = "notion-cli";
    rev = "v${version}";
    hash = "sha256-Wy3Xi40dsmk0igxsGiX7fqvgMVnuIcdNkOefUBAgy/I=";
  };

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
