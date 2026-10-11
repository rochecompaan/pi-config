# Replace RPIV Voice with Pi Voice

## Approved scope

Replace `@juicesharp/rpiv-voice` with `@earendil-works/pi-voice` for a local trial.
The user approved this bounded replacement on 2026-10-11.
Preserve the old configuration on branch `rpiv-voice` at commit `f624d782d6ac6cb603dda24c272bfe8961b66a1f`.
Keep upstream defaults and unrelated Pi configuration unchanged.
After verification, squash the replacement onto `main` without pushing it.

## Package and update policy

Pin the upstream default branch to exact commit `df38132d8b698f24caa52c44501910cde60f6e85`.
Use `fetchFromGitHub` with a fixed source hash.
Replace the old package, source pin, package output, update unit, and npm lock.
An npm lock fixes dependency versions and download hashes.
Repair missing download metadata in the initial upstream lock without changing dependency versions.
The existing maintained-lock policy carries that lock forward when the source changes.
Do not add separate update units for native dependencies.

Nix supplies the recorder, transcription libraries, Koffi, and FFmpeg.
Patch native binaries for Nix library paths and remove unused Koffi musl variants.
Use the packaged FFmpeg executable when neither upstream environment override is set.
Do not change the extension's commands, shortcut, model selection, or transcription behavior.

## Verification and limits

Run the runtime extension-load check and full flake check.
The native-load check must load the recorder and the CPU transcription backend without downloading a model.
Run the existing maintenance tests, inventory audit, and updater dry preparation.
Use formatting and build checks instead of new tests that assert static configuration.

Audio recording, model download, and transcription quality require a manual trial after activation.
Use `/voice-settings` to select a model and `/voice` or `Ctrl+Alt+Z` to record.
The extension shows recording state in its own widget.
The existing footer's voice indicator is not connected to this extension.
