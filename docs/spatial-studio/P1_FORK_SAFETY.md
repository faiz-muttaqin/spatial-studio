# P1.0 — Fork publication safety

Guard inherited upstream publication actions by the exact canonical repository identity `pascalorg/editor`. A downstream fork must not publish Pascal npm packages, GHCR images, registry entries or legacy registry status changes. Keep upstream job definitions for future synchronization.

| Workflow | On Spatial Studio | On canonical Pascal |
|---|---|---|
| release.yml | All five jobs skipped, including npm, release tags, registry and GHCR | Existing conditions preserved |
| mcp-registry.yml | Read-only manifest validation remains; upstream hosted probe, publish and hosted parity skipped | Existing conditions preserved |
| mcp-registry-deprecate-legacy.yml | Legacy status mutation skipped; OIDC permission job-scoped | Existing mutation behavior preserved |
| ci.yml, mcp-ci.yml, docker.yml | Unchanged | Unchanged |

No workflow dispatch, registry mutation, publishing or deployment performed. Existing workflow definitions on older refs are not protected by this PR: do not dispatch inherited release/registry/deprecate workflows on old refs. Keep Actions permissions and secrets least-privileged. Repository owner should check Settings > Actions and enable ordinary CI if no runs are created. Connector cannot change repository Actions settings. Avoid enabling upstream release credentials; no rebranding or publishing to downstream namespaces yet.

Verification: source transformations checked all five release jobs have repository guards, registry publish/hosted checks are guarded, read-only manifest validation remains, and legacy OIDC permission is job-scoped. GitHub Actions validation and runtime build not executed locally. Review the diff, confirm ordinary CI and MCP tests run, and confirm no publication jobs can execute in this fork. Do not dispatch publishing workflows merely to test the guard.

Separate agent owns VM deployment; no Dockerfile, compose, runtime or dependency changes in this PR. Next: P1.1 local MCP/editor and WebXR capability audit, plus license inventory.
