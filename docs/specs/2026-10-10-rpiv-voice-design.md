# Local voice dictation with rpiv-voice

## Approved behavior

Replace `@codexstar/pi-listen` with `@juicesharp/rpiv-voice`.
Use the upstream `/voice` command without a custom keyboard shortcut.
Enter pastes the transcript into the editor. Esc cancels dictation.
Remove the old `Ctrl+Alt+P` shortcut and the `voice` configuration from `settings.json`.

Speech recognition runs locally after the first model download.
Whisper generates a live preview about once per second. This is not a streaming recognizer.
The first download is about 198 MB. The installed model uses about 157 MB.
Keep the upstream multilingual Whisper base model and configuration defaults.

## Package boundary

Continue to support `x86_64-linux` only.
Build the published npm package with `pkgs.buildNpmPackage`.
Pin version `2.12.0` and its source hash in `nix/dependency-pins.json`.
Save the maintained npm lockfile at `nix/packages/rpiv-voice-package-lock.json`.
The initial lock resolves Sherpa `1.13.8` and Decibri `3.4.2`.

Package regular dependencies, including `@juicesharp/rpiv-config`, Sherpa, Decibri, and their Linux native packages.
Pi supplies its own peer dependencies. Do not install another Pi runtime in the voice output.
Do not add the optional `@juicesharp/rpiv-i18n` package. The upstream English fallback remains available.
Use `autoPatchelfHook` for native binaries and include the Linux audio libraries needed by Decibri.

Load `${rpivVoice}/lib/node_modules/@juicesharp/rpiv-voice` through generated Pi package paths.
Do not use npm or Git installation at runtime.
Resolve `tar` and `bzip2` through Nix store paths for model extraction.
Fail the build if upstream changes invalidate the extraction substitutions.

Keep the new build recipe in `nix/packages/rpiv-voice.nix`.
Keep the managed source fetcher in `nix/packages/pi-deps.nix` so the existing source audit covers it.
Do not restructure other package recipes.

## Dependency updates

Replace the `pi-listen` update unit with `rpiv-voice`.
Use the existing `npm-latest` source policy and maintained-lock policy.
The unit owns the source pin and its npm lockfile.
Remove the separate Sherpa source records and companion policies.
The npm lockfile now owns Sherpa, Decibri, and their platform packages together.
Update the current dependency-update guide. Leave historical plans and specifications unchanged.

## Verification

Use direct build and runtime verification instead of tests that only assert static configuration.
Keep an automated native-loading check that runs through the packaged Pi executable.
The check must load both Sherpa and Decibri from the packaged resource path.
Do not open a microphone or download a model during the native-loading check.

Run the existing dependency-update tests with `dependency-update-tools` on `PATH`.
Run the inventory command and make sure that its source audit accepts the replacement.
Build `.#packages.x86_64-linux.rpiv-voice`.
Build `.#checks.x86_64-linux.rpiv-voice-native-load`.
Build `.#checks.x86_64-linux.pi-config-extension-load`.
Run `nix flake check --accept-flake-config --print-build-logs`.
Stage new files before the git-backed flake checks.

Use a temporary home directory to make sure that Pi loads the new extension without changing user state.
Make sure that the generated resource path contains no runtime Git or npm source.
Make sure that the output contains regular dependencies but no copied Pi peer runtime.
Make sure that a small bzip2 archive extracts with the packaged tar command when `PATH` is empty.

After deployment, manually run `/voice`, allow the first model download, and speak into an available microphone.
Make sure that previews appear, Enter pastes text, and Esc leaves the editor unchanged.
Record any check that cannot run. Do not claim microphone verification from an import check.

## Excluded work

Do not add a new shortcut, cloud speech recognition, text-to-speech, or another language package.
Do not migrate or delete existing user model files or voice configuration.
Do not change Den permissions or upstream model storage paths.
Do not modify the Pi executable, flake inputs, or `pi-intervals` source.
