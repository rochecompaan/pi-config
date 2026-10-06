# Den Managed Pi State Files Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an anchored Den primitive that restores authoritative Nix-store links in Pi's selected agent directory before Fence starts.

**Architecture:** Extend each manifest state binding with a deterministic list of managed leaves. A focused Go `managedstate` package will open the validated state root by file descriptor, walk relative parents without following symlinks, and atomically rename temporary symlinks over file or symlink leaves. The launcher will run this step after state-directory selection and before its post-mutation revalidation and Fence lifecycle.

**Tech Stack:** Nix flakes, flake-parts, Go 1.24, `golang.org/x/sys/unix`, Den's JSON launcher manifest, Fence.

## Global Constraints

- Start from Den commit `c37638b` (`chore(pi): update to 0.87.1`) on `origin/main`. This baseline already includes the Pi 0.87.1 tool-result preview patch, its regression test, and patch-hash validation.
- Public constructor shape: `stateFiles.agent = { "relative/path" = storeSource; };`.
- Only the Pi `agent` binding accepts managed files in this change. Pi sessions and Claude state remain unmanaged.
- Every source must resolve inside `/nix/store`; retain its Nix string context and include a link-farm root in the Fence closure so file subpaths pull in their owning store paths.
- Every destination must be a normalized, non-empty relative path with no `.` or `..` component.
- Anchor all destination operations to the already validated state directory. Do not use path-based `MkdirAll`, `Remove`, or `Rename` below that root.
- Create missing parent directories as mode `0700`. Existing parents must be real directories owned by the runtime user; normalize their mode to `0700` through the open directory descriptor.
- Replace only absent leaves, regular files, or symlinks. Reject a real directory or any other special file at a managed leaf.
- Restore every managed leaf on every launch. Do not preserve user edits to a managed leaf between launches.
- Create a temporary symlink in the destination parent and rename it over the leaf so each replacement is atomic.
- A failure must name the managed destination and the failed condition, without printing mutable file contents or credentials.
- Successful replacements may remain after a later replacement fails, but Pi must not start.
- Keep the existing Pi resource, state-selection, rollback, Fence, and RepoWolf behavior unchanged outside this new step.

---

## Execution Workspace

Implement this plan in a new Den worktree. Do not write these changes in Den's `main` checkout or in the existing Pi-update worktree.

```bash
cd /home/roche/projects/den
git fetch --all --prune
git worktree add .worktrees/pi-managed-state-files \
  -b feat/pi-managed-state-files origin/main
cd .worktrees/pi-managed-state-files
```

Before editing, confirm that `HEAD` is `c37638b` or a reviewed descendant of it, `nix/lib/mk-pi.nix` asserts Pi `0.87.1`, and the baseline contains `nix/packages/pi-tool-result-preview-dist.patch`.

## File Structure

| Path | Responsibility |
| --- | --- |
| `internal/manifest/manifest.go` | JSON contract for managed files and validation of source/destination strings. |
| `internal/manifest/manifest_test.go` | Manifest acceptance and rejection cases. |
| `internal/managedstate/restore.go` | Public restore orchestration, deterministic error wrapping, source and destination validation. |
| `internal/managedstate/dir_unix.go` | File-descriptor-anchored parent walk and atomic symlink replacement on Linux and Darwin. |
| `internal/managedstate/restore_test.go` | Behavior tests for replacement, path safety, permissions, root identity, and partial failure. |
| `internal/launch/launch.go` | Invoke managed-state restoration in the required launch sequence. |
| `internal/launch/state.go` | Convert a selected state handle into the narrow managed-state root contract; share state-handle revalidation. |
| `internal/launch/lifecycle_test.go` | Prove restore ordering, failure short-circuiting, and revalidation before lifecycle start. |
| `nix/lib/pi-options.nix` | Validate and normalize the public `stateFiles.agent` option. |
| `nix/lib/mk-pi.nix` | Attach the normalized managed files to Pi's `agent` state binding. |
| `nix/lib/mk-agent-sandbox.nix` | Serialize managed files and include their store roots in the closure. |
| `nix/lib/module-options.nix` | Expose the same option through Home Manager and devenv. |
| `nix/check-support/pi-managed-state.nix` | Nix API, manifest, closure, and runtime restore fixture. |
| `modules/checks/pi-managed-state.nix` | Publish the focused flake check. |
| `nix/check-support/pi-module-api.nix` | Confirm module forwarding for `stateFiles`. |
| `README.md` | Document the constructor/module contract and launch-time authority rule. |

### Task 1: Extend the launcher manifest contract

**Files:**
- Modify: `internal/manifest/manifest.go:65-77`
- Modify: `internal/manifest/manifest_test.go:9-91`

**Interfaces:**
- Consumes: the existing version-2 `StateBinding` JSON object.
- Produces: `manifest.ManagedStateFile{Destination string, Source string}` and `StateBinding.ManagedFiles []ManagedStateFile`.

- [ ] **Step 1: Add failing manifest tests**

Add `managedFiles` to the binding in `validManifest`:

```json
"managedFiles":[{"destination":"settings.json","source":"/nix/store/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-settings.json"}]
```

Extend `TestValidateStateBinding` with these cases:

```go
{"absolute managed destination", `"destination":"settings.json"`, `"destination":"/settings.json"`, "managedFiles.destination"},
{"dot managed destination", `"destination":"settings.json"`, `"destination":"profiles/./settings.json"`, "managedFiles.destination"},
{"parent managed destination", `"destination":"settings.json"`, `"destination":"profiles/../settings.json"`, "managedFiles.destination"},
{"empty managed destination", `"destination":"settings.json"`, `"destination":""`, "managedFiles.destination"},
{"outside-store managed source", `"source":"/nix/store/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-settings.json"`, `"source":"/tmp/settings.json"`, "managedFiles.source"},
{"unclean managed source", `"source":"/nix/store/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-settings.json"`, `"source":"/nix/store/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-dir/../settings.json"`, "managedFiles.source"},
```

Add a separate duplicate-destination case:

```go
func TestValidateStateBindingRejectsDuplicateManagedDestination(t *testing.T) {
	duplicate := strings.Replace(
		validManifest,
		`"managedFiles":[{"destination":"settings.json","source":"/nix/store/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-settings.json"}]`,
		`"managedFiles":[`+
			`{"destination":"settings.json","source":"/nix/store/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-settings.json"},`+
			`{"destination":"settings.json","source":"/nix/store/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb-settings.json"}]`,
		1,
	)
	if _, err := Load(writeManifest(t, duplicate)); err == nil || !strings.Contains(err.Error(), "duplicate managed destination") {
		t.Fatalf("Load() error = %v, want duplicate managed destination", err)
	}
}
```

- [ ] **Step 2: Run the focused tests and confirm RED**

Run:

```bash
go test ./internal/manifest -run 'TestLoadVersion2Manifest|TestValidateStateBinding' -count=1
```

Expected: FAIL because `managedFiles` is unknown.

- [ ] **Step 3: Add the manifest types and validation**

Keep manifest version 2 because this is an additive field: the new launcher accepts old manifests with an empty list, while an old launcher rejects the new unknown field.

Add:

```go
type StateBinding struct {
	Name                 string             `json:"name"`
	ExplicitPath         *string            `json:"explicitPath"`
	InheritedEnvironment string             `json:"inheritedEnvironment"`
	DefaultPath          string             `json:"defaultPath"`
	DefaultWritablePaths []string           `json:"defaultWritablePaths"`
	Exports              []StateExport      `json:"exports"`
	ManagedFiles         []ManagedStateFile `json:"managedFiles"`
}

type ManagedStateFile struct {
	Destination string `json:"destination"`
	Source      string `json:"source"`
}
```

Add these helpers and call them from `StateBinding.validate`:

```go
func (s StateBinding) validateManagedFiles() error {
	seen := make(map[string]struct{}, len(s.ManagedFiles))
	for _, file := range s.ManagedFiles {
		if !safeRelativePath(file.Destination) {
			return errors.New("manifest field stateBindings.managedFiles.destination is invalid")
		}
		if _, exists := seen[file.Destination]; exists {
			return errors.New("manifest field stateBindings.managedFiles has duplicate managed destination")
		}
		seen[file.Destination] = struct{}{}
		if !safeStorePath(file.Source) {
			return errors.New("manifest field stateBindings.managedFiles.source is invalid")
		}
	}
	return nil
}

func safeRelativePath(path string) bool {
	if path == "" || filepath.IsAbs(path) || filepath.Clean(path) != path || strings.IndexByte(path, 0) >= 0 || strings.ContainsAny(path, "\r\n") {
		return false
	}
	for _, component := range strings.Split(path, string(filepath.Separator)) {
		if component == "" || component == "." || component == ".." {
			return false
		}
	}
	return true
}

func safeStorePath(path string) bool {
	return safePath(path) && strings.HasPrefix(path, "/nix/store/")
}
```

Do not sort in Go. Preserve the deterministic order emitted by Nix so failures identify the first configured destination.

- [ ] **Step 4: Run manifest tests and the full internal manifest package**

Run:

```bash
gofmt -w internal/manifest/manifest.go internal/manifest/manifest_test.go
go test ./internal/manifest -count=1
```

Expected: PASS.

- [ ] **Step 5: Commit the manifest contract**

```bash
git add internal/manifest/manifest.go internal/manifest/manifest_test.go
git commit -m "feat(pi): define managed state files in launcher manifest"
```

### Task 2: Implement anchored, atomic managed-state restoration

**Files:**
- Create: `internal/managedstate/restore.go`
- Create: `internal/managedstate/dir_unix.go`
- Create: `internal/managedstate/restore_test.go`

**Interfaces:**
- Consumes: `Root{Path string, Device uint64, Inode uint64}` and `[]manifest.ManagedStateFile`.
- Produces: `Result{Mutated bool}` plus an error. `Mutated` is true after the first parent creation, permission correction, or leaf rename.
- Public entry point: `func Restore(root Root, files []manifest.ManagedStateFile) (Result, error)`.

- [ ] **Step 1: Write failing behavior tests**

Create table-driven tests with an injected store directory and UID. Use this internal seam in tests:

```go
type dependencies struct {
	storeDir  string
	uid       uint32
	tempName  func() (string, error)
}

func restore(root Root, files []manifest.ManagedStateFile, deps dependencies) (Result, error)
```

Cover these behaviors:

```go
func TestRestoreCreatesParentsAndReplacesLeaves(t *testing.T)
func TestRestoreReplacesRegularFileAndExistingSymlink(t *testing.T)
func TestRestorePreservesUnmanagedSiblings(t *testing.T)
func TestRestoreRejectsParentSymlink(t *testing.T)
func TestRestoreRejectsDirectoryLeaf(t *testing.T)
func TestRestoreRejectsSpecialLeaf(t *testing.T)
func TestRestoreRejectsSourceThatResolvesOutsideStore(t *testing.T)
func TestRestoreRejectsChangedRootIdentity(t *testing.T)
func TestRestoreReportsMutationBeforeLaterFailure(t *testing.T)
```

In the successful test, assert all of the following:

```go
if result.Mutated != true { t.Fatal("Restore() did not report mutation") }
if target, err := os.Readlink(filepath.Join(rootPath, "profiles/pi-subagents/openai.json")); err != nil || target != source {
	t.Fatalf("managed link = %q, %v; want %q", target, err, source)
}
if mode := mustMode(t, filepath.Join(rootPath, "profiles")); mode.Perm() != 0o700 {
	t.Fatalf("profiles mode = %o, want 700", mode.Perm())
}
if got := mustRead(t, filepath.Join(rootPath, "auth.json")); got != "keep" {
	t.Fatalf("unmanaged auth changed: %q", got)
}
```

For every rejection, require the error to contain the destination, such as `profiles/pi-subagents/openai.json`, and a stable condition phrase (`parent is a symbolic link`, `managed leaf is a directory`, `source resolves outside the Nix store`, or `state root identity changed`).

- [ ] **Step 2: Run the new package and confirm RED**

Run:

```bash
go test ./internal/managedstate -count=1
```

Expected: FAIL because the package implementation does not exist.

- [ ] **Step 3: Implement validation and orchestration in `restore.go`**

Use this public surface:

```go
package managedstate

type Root struct {
	Path   string
	Device uint64
	Inode  uint64
}

type Result struct {
	Mutated bool
}

func Restore(root Root, files []manifest.ManagedStateFile) (Result, error) {
	return restore(root, files, dependencies{
		storeDir: "/nix/store",
		uid:      uint32(os.Getuid()),
		tempName: randomTempName,
	})
}
```

Implement these exact rules:

1. Return an unchanged result for an empty file list.
2. Validate `Root.Path` is clean and absolute and the expected device/inode are non-zero.
3. Before opening or changing any destination parent, validate the complete file list into `[]preparedFile`. Revalidate every destination with the same component rules as the manifest boundary.
4. During that preflight, require every source to be clean, absolute, and lexically below `deps.storeDir`.
5. Resolve every source with `filepath.EvalSymlinks`; require the resolved path to remain below `deps.storeDir`; require `os.Stat` to succeed. Keep the original store path as the symlink target.
6. Only after the full preflight succeeds, open the root through `openRoot` and compare the descriptor's device/inode with `Root` before changing anything.
7. Restore prepared files in manifest order and wrap errors as `managed state "<destination>": <condition>`.
8. Return `Result{Mutated: true}` with an error when an earlier filesystem operation changed the tree.

Generate temporary names from 16 bytes of `crypto/rand` and hex encoding. The name must be a single basename with a `.den-managed-` prefix.

- [ ] **Step 4: Implement descriptor-anchored operations in `dir_unix.go`**

Use `golang.org/x/sys/unix` for all operations beneath the root. The core shape is:

```go
type anchoredDir struct {
	fd  int
	uid uint32
}

func openRoot(root Root, uid uint32) (*anchoredDir, error)
func (d *anchoredDir) close() error
func (d *anchoredDir) restore(destination, source string, tempName func() (string, error)) (bool, error)
func openOrCreateParent(parentFD int, name string, uid uint32) (fd int, mutated bool, err error)
func replaceLeaf(parentFD int, leaf, source string, tempName func() (string, error)) (bool, error)
```

Implementation details:

- Open the root and each existing parent with `O_RDONLY|O_DIRECTORY|O_NOFOLLOW|O_CLOEXEC`.
- Inspect every descriptor with `Fstat`. Require a directory and `stat.Uid == deps.uid`.
- If an existing parent mode is not `0700`, call `Fchmod(fd, 0700)` and mark the result mutated. Reject a setuid, setgid, or sticky parent if the mode cannot be normalized.
- On `ENOENT`, call `Mkdirat(parentFD, component, 0700)`, then open and validate the new directory.
- Before replacement, call `Fstatat(..., AT_SYMLINK_NOFOLLOW)`. Allow `ENOENT`, a regular file, or a symlink. Reject directories and all other file types.
- Create the temporary link with `Symlinkat(source, parentFD, temporaryName)`. Retry a generated-name collision, but stop after 16 attempts.
- Call `Renameat(parentFD, temporaryName, parentFD, leaf)` to atomically replace the leaf.
- Always `Unlinkat` the temporary name on an error after creation.
- Close child descriptors in reverse walk order. Never construct a destination absolute path for a mutating syscall.

Keep `restore.go` and `dir_unix.go` each below roughly 200 meaningful lines. If either grows beyond 250 lines, extract source validation or descriptor metadata into a narrowly named file rather than a `utils.go` file.

- [ ] **Step 5: Run focused tests, race tests, and Darwin compile validation**

Run:

```bash
gofmt -w internal/managedstate/*.go
go test ./internal/managedstate -count=1
go test -race ./internal/managedstate -count=1
GOOS=darwin GOARCH=amd64 go test -c ./internal/managedstate -o "$TMPDIR/managedstate-darwin.test"
```

Expected: all Linux tests PASS and the Darwin test binary compiles.

- [ ] **Step 6: Commit the restore module**

```bash
git add internal/managedstate
git commit -m "feat(pi): restore managed state through anchored links"
```

### Task 3: Expose `stateFiles.agent` through Nix and include its closure

**Files:**
- Modify: `nix/lib/pi-options.nix:5-84`
- Modify: `nix/lib/mk-pi.nix:3-126`
- Modify: `nix/lib/mk-agent-sandbox.nix:32-89`
- Modify: `nix/lib/module-options.nix:86-139`
- Create: `nix/check-support/pi-managed-state.nix`
- Create: `modules/checks/pi-managed-state.nix`
- Modify: `nix/check-support/pi-module-api.nix`
- Modify: `README.md` in the “Pi support” and “Public configuration” sections

**Interfaces:**
- Consumes: `stateFiles.agent`, an attribute set from destination strings to derivations, Nix paths, or context-bearing store strings.
- Produces: sorted `managedFiles` entries on the `agent` state binding and store roots in `closurePathsFile`.

- [ ] **Step 1: Add the failing flake check and module assertion**

Create `modules/checks/pi-managed-state.nix`:

```nix
{ inputs, ... }:
{
  perSystem = { pkgs, ... }: {
    checks.pi-managed-state = import ../../nix/check-support/pi-managed-state.nix {
      inherit inputs pkgs;
    };
  };
}
```

Create `nix/check-support/pi-managed-state.nix` with a store source, a constructor call, and rejection assertions:

```nix
{ inputs, pkgs }:
let
  lib = pkgs.lib;
  mkPi = import ../lib/mk-pi.nix { inherit inputs pkgs; };
  settings = pkgs.writeText "managed-settings.json" ''{"theme":"default"}\n'';
  pathSource = ./pi-module-api.nix;
  pi = mkPi {
    stateFiles.agent = {
      "settings.json" = settings;
      "profiles/pi-subagents/openai.json" = pathSource;
    };
  };
  fails = value: !(builtins.tryEval (builtins.deepSeq value value)).success;
in
assert fails ((mkPi { stateFiles.agent."../escape" = settings; }).outPath);
assert fails ((mkPi { stateFiles.agent."settings.json" = "/tmp/settings.json"; }).outPath);
pkgs.runCommand "pi-managed-state"
  { nativeBuildInputs = [ pkgs.jq ]; manifest = pi.denManifest; inherit settings pathSource; }
  ''
    jq -e --arg settings "$settings" --arg pathSource "$pathSource" '
      .stateBindings[0].managedFiles == [
        {destination:"profiles/pi-subagents/openai.json", source:$pathSource},
        {destination:"settings.json", source:$settings}
      ] and
      .stateBindings[1].managedFiles == []
    ' "$manifest"
    closure=$(jq -r .closurePathsFile "$manifest")
    grep -Fqx "$settings" "$closure"
    grep -Fqx "$pathSource" "$closure"
    touch "$out"
  ''
```

Add a Home Manager/devenv module fixture in `nix/check-support/pi-module-api.nix` that sets:

```nix
programs.den.pi.stateFiles.agent."settings.json" = settings;
```

and asserts the constructed Pi package's manifest carries the same source.

- [ ] **Step 2: Stage the new check files and confirm RED**

New flake files are invisible to git-backed flake evaluation until staged.

```bash
git add modules/checks/pi-managed-state.nix nix/check-support/pi-managed-state.nix
nix build .#checks.x86_64-linux.pi-managed-state --no-link
```

Expected: FAIL because `stateFiles` is not an accepted Pi option.

- [ ] **Step 3: Validate and normalize the public Pi option**

In `nix/lib/pi-options.nix`, add `stateFiles` to defaults and `allowedRootOptions`:

```nix
stateFiles = { agent = { }; };
```

Normalize the optional outer set before validating it:

```nix
stateFiles = defaults.stateFiles // (raw.stateFiles or { });
```

Use these rules:

```nix
allowedStateFileBindings = [ "agent" ];
isStoreSource = value:
  isResource value
  || (builtins.isString value
      && lib.hasPrefix "${builtins.storeDir}/" value
      && builtins.hasContext value);
isSafeDestination = destination:
  let components = lib.splitString "/" destination; in
  destination != ""
  && builtins.match "^/.*" destination == null
  && builtins.match ".*[\\r\\n].*" destination == null
  && lib.all (component: component != "" && component != "." && component != "..") components;
```

Assert that:

- `stateFiles` is an attribute set.
- It has no key other than `agent`.
- `stateFiles.agent` is an attribute set.
- Every destination passes `isSafeDestination`.
- Every source passes `isStoreSource`.

Return normalized source strings through interpolation:

```nix
stateFiles.agent = lib.mapAttrs (_: source: "${source}") stateFiles.agent;
```

Interpolation is required here rather than `toString`: it copies a plain Nix path into `/nix/store` and retains string context for paths, derivations, and context-bearing store strings. The focused check must use at least one actual Nix path value and assert that its normalized manifest source and closure entry are the resulting store path.

- [ ] **Step 4: Serialize files on the agent binding and add closure roots**

In `nix/lib/mk-pi.nix`, set this field only on the `agent` state binding:

```nix
managedFiles = lib.mapAttrsToList
  (destination: source: { inherit destination source; })
  options.stateFiles.agent;
```

Set the session binding's `managedFiles = [ ];`.

In `nix/lib/mk-agent-sandbox.nix`, keep the additive manifest field compatible with Claude and older adapter fixtures by treating an absent list as empty. Collect its sources before `closureInfo` and retain subpath references through a link farm:

```nix
managedStateSources = lib.concatMap
  (binding: map (file: file.source) (binding.managedFiles or [ ]))
  stateBindings;
managedStateClosure = pkgs.linkFarm "den-managed-state-sources"
  (lib.imap0 (index: source: {
    name = toString index;
    path = source;
  }) managedStateSources);
```

Append `lib.optional (managedStateSources != [ ]) managedStateClosure` to `closureRoots`. Leave adapter state bindings otherwise unchanged: `mkPi` emits `managedFiles` for its agent and session bindings, while older/Claude adapters may omit the additive field. Do not put these sources on `PATH` and do not add them to the Pi resource arguments.

- [ ] **Step 5: Expose the option in modules and documentation**

In `nix/lib/module-options.nix`, define:

```nix
stateFiles.agent = mkOption {
  type = types.attrsOf (types.oneOf [ types.path types.package (types.strMatching "^/nix/store/.*") ]);
  default = { };
  description = "Authoritative Nix-store files or directories restored as links below the selected Pi agent directory before each launch.";
};
```

Document this constructor and module example in `README.md`:

```nix
stateFiles.agent = {
  "settings.json" = settingsFile;
  "profiles/pi-subagents/openai.json" = "${profiles}/openai.json";
};
```

State plainly that Den replaces these leaves before every launch, leaves all unlisted paths mutable, rejects parent symlinks and directory leaves, and does not import host credentials.

- [ ] **Step 6: Run focused Nix checks**

```bash
nix build .#checks.x86_64-linux.pi-managed-state --no-link
nix build .#checks.x86_64-linux.pi-module-api --no-link
nix build .#checks.x86_64-linux.pi-package-api --no-link
```

Expected: PASS. No new test should assert README text; the constructor, module, manifest, and closure checks prove the behavior.

- [ ] **Step 7: Commit the Nix API**

```bash
git add README.md \
  nix/lib/pi-options.nix nix/lib/mk-pi.nix nix/lib/mk-agent-sandbox.nix nix/lib/module-options.nix \
  nix/check-support/pi-managed-state.nix nix/check-support/pi-module-api.nix \
  modules/checks/pi-managed-state.nix
git commit -m "feat(pi): expose managed agent state files"
```

### Task 4: Wire restoration into the launch lifecycle

**Files:**
- Modify: `internal/launch/launch.go:24-164`
- Modify: `internal/launch/state.go:5-58`
- Modify: `internal/launch/lifecycle.go:84-89`
- Modify: `internal/launch/lifecycle_test.go`
- Extend: `nix/check-support/pi-managed-state.nix`

**Interfaces:**
- Consumes: state bindings and handles in the same manifest order.
- Produces: restored links before `StateInputsFrom` and before the lifecycle runner; a post-restore state-directory revalidation gate.

- [ ] **Step 1: Add failing launch-order tests**

Add an internal injection seam without changing public `Run`:

```go
type managedStateRestorer func(managedstate.Root, []manifest.ManagedStateFile) (managedstate.Result, error)
```

Add a private `runWithLifecycleAndHomeAndRestore` that receives this function. Existing `runWithLifecycleAndHome` delegates to it with `managedstate.Restore`.

Write these tests:

```go
func TestRunRestoresManagedStateBeforeLifecycle(t *testing.T)
func TestRunStopsBeforeLifecycleWhenManagedStateFails(t *testing.T)
func TestRunRevalidatesStateAfterManagedMutation(t *testing.T)
func TestRunCommitsPartiallyMutatedManagedRoot(t *testing.T)
```

The first test's fake restorer must record the root identity and set a flag; the fake lifecycle must fail the test unless that flag is already true. The failure test must return:

```go
managedstate.Result{}, errors.New(`managed state "settings.json": parent is a symbolic link`)
```

and assert the same safe message reaches stderr and the lifecycle is not called.

The partial-mutation test must return `managedstate.Result{Mutated: true}` with an error, then assert the newly created agent directory remains after deferred handle cleanup. This preserves successful earlier replacements without producing a rollback-failure diagnostic.

- [ ] **Step 2: Run launch tests and confirm RED**

```bash
go test ./internal/launch -run 'TestRun.*Managed' -count=1
```

Expected: FAIL because managed restoration is not in the launch sequence.

- [ ] **Step 3: Add the launch sequence**

In `internal/launch/state.go`, add:

```go
func managedRoot(handle *configdir.Handle) managedstate.Root {
	return managedstate.Root{
		Path: handle.CanonicalPath, Device: handle.Device, Inode: handle.Inode,
	}
}

func revalidateStateHandles(handles []*configdir.Handle) error {
	for _, handle := range handles {
		if err := handle.Revalidate(); err != nil {
			return err
		}
	}
	return nil
}
```

After `plan.Open` and before `StateInputsFrom`, use manifest/binding index correspondence:

```go
for index, binding := range launcherManifest.StateBindings {
	result, restoreErr := restore(managedRoot(handles[index]), binding.ManagedFiles)
	if result.Mutated {
		handles[index].Commit()
	}
	if restoreErr != nil {
		fmt.Fprintln(stderr, restoreErr)
		return 1
	}
}
if err := revalidateStateHandles(handles); err != nil {
	fmt.Fprintln(stderr, err)
	return 1
}
```

An empty managed list is a no-op and must not commit the handle. Keep the existing final revalidation immediately before Fence process start, but replace its duplicated loop in `lifecycle.go` with `revalidateStateHandles(handles)`.

- [ ] **Step 4: Extend the Nix runtime fixture**

Extend `nix/check-support/pi-managed-state.nix` to invoke the real wrapper with a temporary valid RepoWolf environment and custom Pi state directories. It may exit later at Fence preflight or the intentionally invalid provider; inspect state after the call rather than requiring a zero exit.

The fixture must prove:

1. A fresh launch creates both managed links.
2. Replacing `settings.json` with a regular file is corrected on the next launch.
3. `auth.json` and `profiles/pi-subagents/custom.json` retain their exact contents.
4. A `profiles` parent symlink causes a non-zero launch before Pi, the log names `profiles/pi-subagents/openai.json`, and the outside directory is unchanged.

For item 3, compare the unmanaged files byte-for-byte with expected files, such as with `cmp`; do not use command substitution because it strips trailing newlines. For item 4, compare the complete outside tree before and after the rejected launch, or explicitly assert that it still contains only the original sentinel and no created `pi-subagents` entry. Checking only the sentinel and final managed leaf is insufficient.

Use a known-valid test-only RepoWolf tuple:

```bash
export REPOWOLF_ENDPOINT=https://broker.example.test/
export REPOWOLF_TOKEN=rw1_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
printf certificate > "$TMPDIR/ca.pem"
chmod 0400 "$TMPDIR/ca.pem"
export REPOWOLF_CA_FILE="$TMPDIR/ca.pem"
```

Run the wrapper under a 20-second timeout and reject a timeout status so the check cannot hide a hung process.

- [ ] **Step 5: Run unit, runtime, and full Den checks**

```bash
gofmt -w internal/launch/*.go
go test ./internal/manifest ./internal/managedstate ./internal/launch -count=1
go test -race ./internal/managedstate ./internal/launch -count=1
nix build .#checks.x86_64-linux.launcher-unit --no-link
nix build .#checks.x86_64-linux.pi-managed-state --no-link
nix build .#checks.x86_64-linux.pi-resources --no-link
nix flake check --print-build-logs
```

Expected: PASS.

- [ ] **Step 6: Commit lifecycle integration**

```bash
git add internal/launch nix/check-support/pi-managed-state.nix
git commit -m "feat(pi): restore managed state before Fence launch"
```

## Final Den Verification and Handoff

- [ ] Confirm the worktree is clean:

```bash
git status --short
```

Expected: no output.

- [ ] Record the reviewed Den head for the downstream lock update:

```bash
git rev-parse HEAD
git log --oneline c37638b..HEAD
```

- [ ] Request adversarial review against `docs/specs/2026-09-27-den-bundle-design.md`, with special attention to descriptor anchoring, parent symlink races, source closure inclusion, partial mutation, and Darwin compilation.

- [ ] After review fixes and repeat verification, push the Den branch and squash-merge it into `main` unless the user explicitly asks to preserve its individual commits.

The roche-pi plan must not update `flake.lock` until this Den head is available from the pinned input URL.
