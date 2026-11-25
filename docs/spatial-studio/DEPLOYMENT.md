# VM deployment and CI hygiene (P1)

The upstream Dockerfile uses Bun 1.4.4 and Node to build the portable runtime. It stores SQLite and artifacts under `/data`. Compose defaults to `ghcr.io/pascalorg/pascal-editor:latest`. Use a local image built from the fork for Spatial Studio.

## Spatial Studio VM

The host's `spatial-studio-update.timer` checks `main` every five minutes and deploys any new commit automatically. There is no approval step: whatever reaches `main`, including lockfile changes, is built and deployed. This suits the current development stage. Reinstate a gate before the instance holds data that matters or has other committers. To check immediately, run `sudo systemctl start spatial-studio-update.service`. Use `journalctl -u spatial-studio-update.service` for build and rollout logs. To retry a failed SHA, remove `/var/lib/spatial-studio/failed-sha` and start the service again. If `main` moves during a build, the built commit is deployed and the next run picks up the newer one.

The service and container recipe are installed under `/usr/local/lib/spatial-studio` on the host. Everything runs in Docker. Build scripts run as a non-root user inside the build container, which receives only the source archive of the commit and the host's container recipe. The live container runs as a non-root user with a read-only root filesystem, all capabilities dropped, `no-new-privileges`, and limits of 2 GB memory, 2 CPUs and 256 processes. It sits on its own Docker network and publishes only on `127.0.0.1`. A leaked or compromised application therefore stays inside the container. It can still reach what the container is given: the `spatial-studio-data` volume and the secrets in `/etc/spatial-studio/editor.env`. Container isolation reduces the impact but does not remove it, so keep backups current. A candidate must pass health and authentication checks before the service replaces the live container. If the replacement fails its checks, the service restores the prior container. Both releases use the same project volume, so take a database and artifact backup before changes that migrate data.

Use this `location` in the HTTPS server block for `spatial-studio.faizmuttaqin.com`.

```nginx
location / {
    proxy_pass http://127.0.0.1:4310;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_buffering off;
    client_max_body_size 100m;
}
```

The editor's login password is stored in `/etc/spatial-studio/editor.env`, readable by root. `PASCAL_SCENE_API_ORIGINS` in that file allows browser requests from the public HTTPS origin. Use `/api/health` to check the proxy. The editor and optional bearer-authenticated Scene API use the same HTTPS address. An MCP client that launches a stdio server uses no listening port. A standalone MCP HTTP server is optional and has its own configurable port, which defaults to `3917` in the CLI.

### Local data snapshot

Use `/root/projects/spatial-studio-data-backup/spatial-studio-data.tar.gz` as the source for external backup. The host's `spatial-studio-backup.timer` refreshes the archive every 15 minutes. It contains a standalone `pascal.db` plus any project artifacts, thumbnails, and sharing settings present in the volume. The worker uses the [SQLite Online Backup API](https://sqlite.org/backup.html) while the editor serves requests. The completed archive replaces the previous one atomically and is readable by root.

Run `sudo systemctl start spatial-studio-backup.service` for a fresh snapshot, and use `journalctl -u spatial-studio-backup.service` to check the result. Inspect or extract the archive in a fresh directory before restoring data to a volume.

### Remote MCP through Nginx

`spatial-studio-mcp.service` serves Streamable HTTP at `http://127.0.0.1:4311/mcp` and uses the same project volume as the editor. Add this block to the HTTPS virtual host at the same level as `location /`, which serves the editor on port `4310`.

```nginx
location = /mcp {
    proxy_pass http://127.0.0.1:4311;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header Connection "";
    proxy_set_header Authorization $http_authorization;
    proxy_buffering off;
    proxy_cache off;
    proxy_read_timeout 300s;
}
```

Run `sudo nginx -t && sudo systemctl reload nginx`. Configure the client with `https://spatial-studio.faizmuttaqin.com/mcp` and send `Authorization: Bearer <token>` using `PASCAL_MCP_HTTP_TOKEN` from the root-only file `/etc/spatial-studio/mcp.env`. An unauthenticated `GET /mcp` should return HTTP `401`. The service restarts after editor deployments and builds a matching MCP image when needed.

### MCP through stdio

The VM's `/usr/local/lib/spatial-studio/mcp-stdio` launcher starts the matching MCP image on demand. It uses the editor's `spatial-studio-data` volume, so `list_scenes` and `load_scene` see the same projects as the web editor. The container uses stdio, with no listener and no network. Use a VM account that already has Docker access.

```bash
codex mcp add spatial-studio -- /usr/local/lib/spatial-studio/mcp-stdio
```

For Codex on another machine, use the existing SSH connection to launch the server on the VM.

```bash
codex mcp add spatial-studio -- ssh -o BatchMode=yes -T user@vm /usr/local/lib/spatial-studio/mcp-stdio
```

The HTTP service builds the matching MCP image when it restarts after an editor deployment. To build the image explicitly, run `/usr/local/lib/spatial-studio/build-image <deployed-sha> mcp` on the VM.

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
