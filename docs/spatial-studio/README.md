# Spatial Studio — downstream development charter

Approved direction: fork Pascal, extend rather than rewrite. Reference baseline: [d7d0b436](https://github.com/pascalorg/editor/commit/d7d0b436f2bda4bfb38fa3d083c1d1816ec7481c); fork main verified at that SHA on 2026-11-25. Planning/source audit only; no runtime feature is claimed implemented.

## Goal and scope
Open a secure website on a phone, capture a room, reconstruct editable architectural geometry, correct dimensions, save the original condition, then redesign manually or with an external AI agent. Preserve observations and verified measurements separately from proposed designs. Single-room first, then connected rooms on one floor. Include walls, floor, ceiling, doors/windows, visible fixtures/lights, surface colors and photo textures, furniture and granular locks. Roof exterior and multi-floor are optional; never infer hidden structure or true total building height from interior photos alone.

P1–P4 are the MVP. P5–P6 are optional. Costing/RAB, procurement, marketplace, RF sensing, custom model training, and mandatory GPU services are excluded. Browser-first; optional native mobile companion is in the same repo, not a separate product or an MVP dependency.

## Read in order
- [UPSTREAM_AUDIT.md](UPSTREAM_AUDIT.md): reuse map and license gates.
- [ARCHITECTURE.md](ARCHITECTURE.md): data, geometry, permissions, MCP.
- [MOBILE.md](MOBILE.md): browser and optional native bridge.
- [CAPTURE_CONTRACT.md](CAPTURE_CONTRACT.md): scan bundle, providers and Android bridge protocol v1.
- [DEPLOYMENT.md](DEPLOYMENT.md): VM, HTTPS, CI/release safeguards.
- [ROADMAP.md](ROADMAP.md): phases, tests and acceptance criteria.
- [STATUS.md](STATUS.md): handoff and next task.

Agents also read root AGENTS.md, DECISIONS.md and relevant wiki/architecture pages. Follow existing boundaries, do not invent APIs, keep a single canonical scene graph and record evidence/PR/checks in STATUS.md. Preserve original MIT copyright, upstream history, and independent asset/dependency notices. Use downstream PRs targeting this fork, never upstream by accident. No private room images, scans, tokens or real addresses in Git. Publishing to Pascal namespaces or registry is prohibited; do not activate upstream release automation. Do not claim untested features are complete.
