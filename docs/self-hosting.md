# Self-hosting LearnHarness

Run one LearnHarness server and use it from every device — laptop, phone,
tablet — through the browser. All data (chats, knowledge graph, practice
sets, settings, provider keys) lives on the server, so every device sees the
same state. Open windows update live: the server pushes change notifications
over `/api/events` (SSE) and each window refetches, so an answer typed on
your phone shows up on your laptop without a reload.

## Quick start (Docker)

```bash
cp .env.server.example .env.server   # then edit: set LH_SERVER_PASSWORD and LH_SESSION_SECRET
docker compose up -d --build
```

Compose publishes the server on `127.0.0.1:3000` only, so other machines
reach it through tailscale serve or a reverse proxy (see "HTTPS and reaching
it from outside your home" below). On the server itself, open
`http://localhost:3000`, sign in with the password, then add your provider
key and models in Settings as usual.

## Desktop app (macOS DMG)

The desktop app can open your server instead of running its own:
**LearnHarness menu → Connect to Server…**, enter the address (for example
`http://my-server:3000` or your Tailscale name), and press Connect. The app
checks it is a LearnHarness server, restarts, and shows the sign-in page.
You stay signed in for 30 days.

- **LearnHarness → Use This Mac Instead** switches back to the bundled local
  server and your local data (it is untouched while connected).
- **LearnHarness → Sign Out of Server** clears this Mac's session.
- If the server can't be reached at launch, the app offers Try Again,
  Change Server…, or Use This Mac.
- The choice is stored in `~/Library/Application Support/LearnHarness/server.json`.
- Subscription sign-in (ChatGPT/Copilot) only works in local mode.

Build an unsigned DMG for your own Mac (no Apple developer account needed):

```bash
npm ci && npx next build && node scripts/build-server.mjs
CSC_IDENTITY_AUTO_DISCOVERY=false npx electron-builder --mac --arm64 \
  -c.mac.identity=- -c.mac.notarize=false -c.mac.hardenedRuntime=false --publish never
```

The DMG lands in `dist/`. Auto-updates check this fork's GitHub releases
(`electron-builder.yml` → `publish`), so upstream releases never replace it.

## iPhone app

A native iPhone app lives in `ios/`. Build and install it with Xcode:
[ios.md](ios.md).

## Server mode

`LH_SERVER_PASSWORD` turns server mode on. With it set:

- every page redirects to `/login` until you sign in;
- every `/api/*` route answers `401` without a valid session;
- a sign-in lasts 30 days per device (HttpOnly, SameSite=Lax cookie);
- 10 wrong passwords from one address lock that address out for 15 minutes.
  The address is the last `X-Forwarded-For` hop, the one your proxy adds,
  so the server must only be reachable through that proxy;
- `Authorization: Bearer <LH_API_TOKEN>` works for non-browser clients.

Sign a device out with `POST /api/auth/logout`. Sign **every** device out by
rotating `LH_SESSION_SECRET` (or the password, if no secret is set).

**Apps only.** `LH_APPS_ONLY=1` makes the server refuse everything except
the LearnHarness desktop and iPhone apps — a browser gets "This server only
works in the LearnHarness apps", even with the password. The apps add
`LearnHarnessDesktop/<version>`, `LearnHarnessiOS/<version>` or
`LearnHarnessAndroid/<version>` to their
User-Agent. That tag is not a secret (it can be faked), so the password is
still what protects the server. Requests with `LH_API_TOKEN` are exempt.

Setting, changing or looking up the password, step by step:
[server-password.md](server-password.md).

Without `LH_SERVER_PASSWORD` nothing changes: desktop and `npm run dev`
behave exactly as before.

## HTTPS and reaching it from outside your home

Don't expose port 3000 to the internet over plain HTTP — the password and
cookie would travel unencrypted. Pick one:

- **Tailscale (simplest):** install it on the server and your devices, then
  run `tailscale serve --bg --https=8446 http://127.0.0.1:3000` and open
  `https://<tailscale-name>:8446`. Only your devices can reach it. Don't
  use `tailscale funnel` for it, which puts it on the public internet.
- **Reverse proxy:** Caddy (`your.domain { reverse_proxy localhost:3000 }`)
  gets a certificate automatically. Keep SSE unbuffered (Caddy does this by
  default; for nginx set `proxy_buffering off` on `/api/`).

## Cursor subscription (cursor-agent)

The Cursor provider runs lessons on your Cursor subscription (Grok 4.7 Fast and
Grok 4.7) through Cursor's official CLI, `cursor-agent`. It works on the server,
so you need the CLI installed and signed in on the server machine:

```bash
curl https://cursor.com/install -fsS | bash   # installs ~/.local/bin/cursor-agent
cursor-agent login
```

Then turn on **Settings → Providers → External CLI → Cursor**. The row shows the
CLI version and whether it is signed in; pick a Cursor model in the model picker.

LearnHarness never runs the CLI with your real `HOME`. Each run gets its own
`HOME` under the data dir (`<data>/cursor-home`), and LearnHarness rewrites two
guards there before every run:

- `cli-config.json` allows only the LearnHarness MCP server and denies shell,
  file and web tools.
- `hooks.json` runs a fail-closed `preToolUse` hook that denies every tool call
  except the LearnHarness tools of that run. This one matters: in cursor-agent
  2026.08.25 the built-in grep and glob tools ignore the permission lists and can
  read any file the server user can read.

Your real `~/.cursor` config and its allowlists are never read. Only the auth dir
is shared, through a symlink, so token refreshes reach your normal login. The
CLI's own sandbox stays off (`--sandbox disabled`): it needs unprivileged user
namespaces, which Ubuntu's AppArmor blocks by default.

Two settings tell the server where things are:

- `LH_CURSOR_AGENT_PATH`: the CLI. Default: `cursor-agent` on `PATH`, then `~/.local/bin`.
- `LH_CURSOR_CONFIG_DIR`: the directory holding Cursor's `auth.json`. Default: `$HOME/.config/cursor`.

In Docker, the container user is `node` (uid 1000). The host CLI runs inside the
container when its install directory is mounted read-only at the same path,
because it ships its own Node and its launcher resolves paths from its own
location. The auth dir must be writable, since the CLI refreshes tokens there.
Add a `docker-compose.override.yml` next to `docker-compose.yml`:

```yaml
services:
  learnharness:
    volumes:
      - ${HOME}/.local/share/cursor-agent:${HOME}/.local/share/cursor-agent:ro
      - ${HOME}/.config/cursor:/home/node/.config/cursor
    environment:
      # The real binary, not the ~/.local/bin symlink. Find it with
      #   readlink -f ~/.local/bin/cursor-agent
      # and update this line after `cursor-agent update`.
      LH_CURSOR_AGENT_PATH: ${HOME}/.local/share/cursor-agent/versions/2026.08.25-3e8eec8/cursor-agent
      LH_CURSOR_CONFIG_DIR: /home/node/.config/cursor
```

Then `docker compose up -d` again. If the Providers row says "not signed in",
run `cursor-agent login` on the host; the container sees the new login at once.

How a lesson runs: one CLI run serves a stretch of the lesson, and fast tools
(search, notes, the graph) are answered inside that run. A question to the
learner ends the run, because the CLI gives each tool call only 60 seconds. When
the learner answers, a new run starts and gets the conversation so far as a
transcript. Each new run spends a few seconds starting up and about 7k tokens of
Cursor's own prompt (mostly cached).

## Data and backups

Everything lives in the `learnharness-data` Docker volume (`/data` in the
container): `chats/`, `graph/`, `practice/`, `jobs/`, `settings.json`,
`auth.json` (provider keys — treat as secret). Back up by copying the volume:

```bash
docker run --rm -v learnharness_learnharness-data:/data -v "$PWD":/out alpine tar czf /out/lh-backup.tgz -C /data .
```

To move existing desktop data to the server, copy the *contents* of the
desktop app's data folder (macOS: `~/Library/Application Support/LearnHarness/data/`)
into the volume, plus `LearnHarness/auth.json` if you want your keys there too.

## Without Docker

```bash
npm ci && npx next build && node scripts/build-server.mjs
LH_SERVER_PASSWORD=... LH_DATA_DIR=/srv/learnharness LH_AUTH_FILE=/srv/learnharness/auth.json \
  HOSTNAME=127.0.0.1 PORT=3000 node .next/standalone/server.js
```

## Limits

- One server process; the stores assume a single writer. Don't run replicas.
- Desktop-only features don't apply in the browser: signing in with a
  ChatGPT/Copilot subscription window, the local Claude Code CLI, and
  dropping file paths from your computer. Use API keys on the server instead.
  The Cursor CLI is the exception: it runs on the server (see above).
- The agent's PDF tool reads paths on the **server's** filesystem.
