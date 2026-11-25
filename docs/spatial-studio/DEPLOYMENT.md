# VM deployment and CI hygiene (P1)

Source inspected: fork Dockerfile, docker-compose.yml, SETUP.md and workflow definitions. No VM deployment or build verified. Upstream Dockerfile uses Bun 1.4.4, real Node in build, portable runtime and persistent /data SQLite/artifacts. Compose defaults to ghcr.io/pascalorg/pascal-editor:latest; plain compose up can run upstream instead of fork. Build from the checkout and use a downstream local image tag.

## Initial private single-workspace smoke
Prerequisites: Git, Docker Engine, reachable VM, DNS domain pointing to VM, Caddy or existing trusted TLS proxy. Allow inbound 80/443 if using Caddy public ACME; restrict SSH. Do not expose raw editor port to internet. Domain below is a placeholder; substitute actual domain. Do not add secrets to repo or shell history.

    git clone https://github.com/faiz-muttaqin/spatial-studio.git
    cd spatial-studio
    git rev-parse HEAD
    docker build -t spatial-studio:local .
    docker volume create spatial-studio-data

Create a private file outside the checkout, e.g. ~/.spatial-studio.env (chmod 600):
    PASCAL_ADMIN_PASSWORD=<strong generated password>
    PASCAL_PUBLIC_URL=https://studio.example.com
    PASCAL_SCENE_API_TOKEN=<optional separate generated token>

    docker run -d --name spatial-studio --restart unless-stopped \
      --env-file "$HOME/.spatial-studio.env" \
      -p 127.0.0.1:3000:3000 \
      -v spatial-studio-data:/data spatial-studio:local

Host-installed Caddyfile example (replace hostname):
    studio.example.com {
        reverse_proxy 127.0.0.1:3000
    }

Validate/reload with the host's Caddy installation; if Caddy runs in Docker, use a shared private network and service DNS instead of host loopback. Existing reverse proxy is fine. See [Caddy reverse proxy](https://caddyserver.com/docs/quick-starts/reverse-proxy) and [automatic HTTPS](https://caddyserver.com/docs/automatic-https). Never use a publicly trusted hostname with insecure browser certificate bypass.

## Acceptance
- curl -fsS http://127.0.0.1:3000/api/health (on VM); HTTPS health via actual hostname.
- Unauthenticated project/API requests denied; login succeeds; create, save, reload a disposable scene, restart container and verify persistence.
- Test mobile Chrome secure context, camera permission, WebXR features independently; no scanner implementation is claimed yet.
- Verify MCP endpoint/auth against actual self-host runtime, do not point agent to upstream hosted Pascal by mistake. Single workspace shares scenes with all logged-in users; no multi-tenant launch. Keep public embeds disabled for private rooms.
- Back up SQLite and artifacts consistently (stop writer or use SQLite online backup), then test restore. Retain old image and backup before updating; do not delete volume. Monitor disk and RAM, record actual resource usage. No GPU required for baseline.

## CI/release
Existing CI: .github/workflows/ci.yml (main push/PR; lint/i18n/types/tests/build etc), docker.yml (image smoke on paths/manual), mcp-ci.yml. Existing release.yml manual dispatch uses upstream npm/OIDC/deploy key and publishing; mcp-registry.yml validates/publishes upstream server identity and remote URL; mcp-registry-deprecate-legacy.yml also inherited. Do not run release or registry publication. Repository Actions activation/settings not verified. Before enabling automation, P1 should guard upstream publishing by repository identity or disable workflows in fork; preserve normal CI and audit full triggers/permissions. No upstream package namespace publishing. Review pinned external plugin licenses and hosted endpoints. Current commit is docs-only; workflow files unchanged.
