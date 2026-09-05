# Remote Pi Integration Design

**Status:** Implemented
**Date:** 2026-09-05  
**Repositories:** `roche-pi` and `homelab-k8s`

## Summary

This change adds the published `remote-pi@0.7.0` Pi extension and deploys its relay on the private homelab network.

The Pi configuration loads only the extension package. It does not install or enable `pi-supervisord`.

The relay runs as one Kubernetes replica with persistent SQLite storage. OpenZiti controls client access and routes traffic directly to the relay service.

`/home/roche/nixdots` is outside the scope of this change.

## Goals

- Package the published `remote-pi@0.7.0` npm release with Nix.
- Add the package root to the generated Pi package paths.
- Load the Remote Pi extension in each generated Pi configuration.
- Deploy one private relay replica through the existing ArgoCD GitOps structure.
- Persist relay membership data in SQLite on a small Longhorn volume.
- Route WebSocket traffic through OpenZiti directly to the relay service.
- Restrict OpenZiti access to identities with the `remote-pi` role.
- Keep the client relay address out of the `roche-pi` source and generated configuration.

## Non-goals

- Do not install, configure, or enable `pi-supervisord`.
- Do not add a system service for Remote Pi.
- Do not add the Remote Pi executables to the user environment.
- Do not commit per-user pairing keys, device data, or relay configuration.
- Do not deploy an Ingress, `NodePort`, or `LoadBalancer` for the relay.
- Do not provide multi-replica relay failover.
- Do not change `/home/roche/nixdots`.
- Do not mutate the Kubernetes cluster from a workstation.

## Confirmed artifacts

### Pi extension

Use the published npm artifact:

```text
remote-pi@0.7.0
```

The package declares `./dist` as its Pi extension. It also contains the `remote-pi` and `pi-supervisord` executable entries.

The Nix integration uses only the package root as a Pi package path. It does not expose or start either executable.

### Relay image

Use this immutable August image digest:

```text
jacobmoura7/remote-pi-relay@sha256:7255159041fe32b02a30ba2e09a671fa00783f24c217750cbdf74c5f8b77a7b6
```

Do not use `v1.0.1`. That May release predates `remote-pi@0.7.0`.

## Architecture

```text
Pi process
  -> remote-pi@0.7.0 extension
  -> ws://remote-pi.compaan
  -> OpenZiti intercept for remote-pi.compaan:80
  -> remote-pi-relay Service:3000
  -> remote-pi-relay Pod:3000
  -> /data/mesh.db on a Longhorn PVC
```

The user stores an HTTP relay address in the extension configuration. The extension converts that address to WS for the WebSocket connection.

The relay serves WebSocket upgrades, `/health`, and mesh endpoints on port 3000.

OpenZiti intercepts `remote-pi.compaan:80/tcp`. It forwards the connection directly to `remote-pi-relay.remote-pi.svc.cluster.local:3000`.

## `roche-pi` design

### Nix package

Add a Nix derivation for `remote-pi@0.7.0` in `nix/packages/pi-deps.nix`.

The derivation will use the published npm tarball and fixed Nix hashes. It will use the existing prebuilt npm-package pattern in this repository.

Add the required npm lock data under `nix/packages/`. This data makes dependency resolution reproducible and network-free during the Nix build.

Export the derivation from `pi-deps.nix`. Add this package root to `piDeps.packagePaths`:

```text
${remotePiExtension}/lib/node_modules/remote-pi
```

`nix/lib/settings.nix` already copies `packagePaths` into the generated Pi `packages` list. No new Pi module interface is necessary.

### Extension-only behavior

Pi reads the package metadata and loads `./dist` as the extension. The integration must not run `/remote-pi install`.

The integration must not add a systemd unit, launch agent, wrapper, or user package for `pi-supervisord`.

The npm artifact can retain its executable files inside the Nix store. The generated Pi configuration only references the package as an extension source.

### Relay configuration

The relay address must not appear in `roche-pi` source or generated Pi configuration.

After installation, the user will run this command once in Pi:

```text
/remote-pi set-relay http://remote-pi.compaan
```

`remote-pi@0.7.0` rejects `ws://` and `wss://` in this command. It stores the HTTP address and converts it to WebSocket internally.

The resulting user configuration remains outside source control.

## `homelab-k8s` design

All `homelab-k8s` changes require a separate task worktree. ArgoCD remains the only deployment mechanism.

### ArgoCD application

Add an ArgoCD application under:

```text
argocd/base/remote-pi-relay/
```

The application points to:

```text
argocd/homelab/remote-pi-relay
```

Use the existing local-application pattern. Set the destination namespace to `remote-pi` and enable namespace creation.

Use automated synchronization with prune and self-heal. Register the application in `argocd/homelab/apps/kustomization.yaml`.

### Relay workload

Add a Kustomize application under:

```text
argocd/homelab/remote-pi-relay/
```

It contains these resources:

- One `Deployment` named `remote-pi-relay`.
- One `ClusterIP` `Service` named `remote-pi-relay`.
- One `PersistentVolumeClaim` named `remote-pi-relay-data`.
- One `kustomization.yaml` that includes these resources.

The deployment has these properties:

- `replicas: 1`
- `strategy.type: Recreate`
- The confirmed image digest from this design
- A container port of 3000
- A `/data` volume mount from the relay PVC
- HTTP readiness and liveness probes on `/health` at port 3000

Use these environment variables:

```text
REMOTEPI_RELAY_PORT=3000
REMOTEPI_MESH_DB_PATH=/data/mesh.db
RUST_LOG=info
```

The readiness probe starts after 2 seconds and runs every 10 seconds. Its timeout is 2 seconds, with three failed attempts.

The liveness probe starts after 10 seconds and runs every 20 seconds. Its timeout is 2 seconds, with three failed attempts.

### Persistent storage

Use a 1 GiB Longhorn PVC with `ReadWriteOnce` access.

SQLite stores its database at `/data/mesh.db`. The `Recreate` strategy prevents two relay pods from writing to this database during a rollout.

The relay database stores signed mesh membership state. Routed messages are not a durable message history.

### Cluster service

Expose port 3000 through a `ClusterIP` service. The service forwards port 3000 to the relay container port.

No `NodePort`, `LoadBalancer`, or `Ingress` is part of this design.

### Direct OpenZiti routing

No Kubernetes Ingress or certificate is required. OpenZiti forwards the plaintext WebSocket stream directly to the relay's ClusterIP service on port 3000.

The hostname appears only in the `homelab-k8s` OpenZiti service. It remains absent from `roche-pi` source and generated settings.

### OpenZiti service

Add these declarative resources under:

```text
argocd/homelab/miniziti-operator/remote-pi/
```

The existing `miniziti-operator` ArgoCD application uses recursive directory loading. No new ArgoCD application is necessary for these resources.

Add a `ZitiService` named `remote-pi` with these properties:

- Service role attribute `remote-pi`
- Router `ziti-router`
- Intercept protocol `tcp`
- Intercept address `remote-pi.compaan`
- Intercept port 80
- Host address `remote-pi-relay.remote-pi.svc.cluster.local`
- Host port 3000

Add a Dial `ZitiAccessPolicy` named `remote-pi-dial`. Select identities by the `remote-pi` role and select the service by its `remote-pi` name.

The policy denies access to identities that do not have the `remote-pi` role. This change does not grant the role to an unnamed identity.

## Data flow

1. The user starts Remote Pi from an interactive Pi process.
2. The extension reads its user-owned relay configuration.
3. The extension converts the stored HTTP address to WS.
4. OpenZiti intercepts the destination for an authorized identity.
5. OpenZiti forwards the TCP stream directly to the relay service on port 3000.
6. The relay routes protocol messages between paired clients and Pi processes.
7. The relay persists signed membership versions in `/data/mesh.db`.

## Security model

OpenZiti authenticates authorized identities and encrypts traffic across its overlay. The final in-cluster hop from the Ziti router to the relay service uses plaintext WebSocket traffic.

Remote Pi does not provide system-wide end-to-end encryption. The relay can read routed protocol content and metadata.

The private, self-hosted relay reduces trust in external infrastructure. The relay pod and its administrators remain inside the trust boundary.

Pairing keys and device state remain on clients. No Kubernetes Secret is required for the relay configuration in this design.

## Failure behavior and operations

### Relay process failure

Kubernetes restarts the container after repeated liveness probe failures. Failed readiness probes remove the pod from service endpoints.

Pi remains usable as a local coding agent when the relay is unavailable. Remote clients cannot connect until the relay recovers.

### Volume failure

The relay cannot start correctly if the Longhorn volume is unavailable. The single-replica design does not provide automatic database failover.

Back up the PVC with the existing Longhorn process. If the database is lost, clients can publish their current membership state after later mutations.

### OpenZiti access failure

An identity without the `remote-pi` role cannot dial the service. Inspect the identity role before changing the service policy.

If direct routing fails for an authorized identity, inspect the Ziti service and the Kubernetes service endpoints before changing the access policy.

## Repository and delivery boundaries

The feature uses separate branches and worktrees for each repository.

The `roche-pi` branch contains the Nix package and generated package-path change. The `homelab-k8s` branch contains only declarative GitOps manifests.

Each repository keeps its own commit history and verification results. No change is required in `nixdots`.

## Verification

### `roche-pi`

Run the required runtime extension-load check:

```sh
nix build .#checks.x86_64-linux.pi-config-extension-load --no-link
```

Run the full flake check:

```sh
nix flake check --accept-flake-config --print-build-logs
```

The baseline full flake check passes with five existing warnings. The change must not add a new warning or error.

Inspect the generated Pi package list. It must contain the Nix store path for `remote-pi` and no private relay address.

Search the changed files for `pi-supervisord`. References inside upstream package metadata are acceptable, but no service or package-path integration is acceptable.

### `homelab-k8s`

Render these Kustomize trees without applying them:

```sh
kustomize build argocd/base/remote-pi-relay
kustomize build argocd/homelab/remote-pi-relay
kustomize build argocd/homelab/apps
```

Validate the rendered built-in resources with `kubeconform`. Use strict mode and report missing external schemas separately.

Validate the `ZitiService` and `ZitiAccessPolicy` YAML against the CRD structure in `argocd/homelab/miniziti-operator/install.yaml`.

Do not run `kubectl apply`, `kubectl patch`, `kubectl delete`, `helm upgrade`, or another cluster-write command.

## Acceptance criteria

- The generated Pi configuration loads `remote-pi@0.7.0` from a Nix store path.
- The Pi runtime extension-load check passes.
- The full `roche-pi` flake check passes without new warnings.
- No Remote Pi supervisor service is installed or enabled.
- The private relay address is absent from `roche-pi` source and generated configuration.
- The relay deployment uses one replica and the `Recreate` strategy.
- The relay image matches the confirmed digest exactly.
- SQLite uses `/data/mesh.db` on a 1 GiB Longhorn PVC.
- The service is `ClusterIP` on port 3000.
- Both health probes use `/health` on port 3000.
- No Kubernetes Ingress or certificate is deployed for the relay.
- OpenZiti exposes `remote-pi.compaan:80/tcp` only to identities with the `remote-pi` role and forwards directly to the relay service on port 3000.
- All Kubernetes and ArgoCD manifests render and validate locally.
- No command mutates the Kubernetes cluster during implementation or verification.
