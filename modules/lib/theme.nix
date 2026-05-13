{ ... }:
{
  perSystem =
    { ... }:
    {
      lib.mkStylixTheme = (import ../../nix/lib/theme.nix { }).mkStylixTheme;
    };
}
