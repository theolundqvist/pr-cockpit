# PR Cockpit contributor and agent guide

This repository is worked on by humans and coding agents alike. Leave it easier to operate than you found it.

## Layout

- `server/`: the Bun server. GitHub ingestion, SQLite cache, mutation queue, HTTP API.
- `ui/`: the Svelte 5 front end (runes: `$state`, `$derived`, `$props`, `$effect`).
- `shell/`: the Electron shell. It only provides the macOS window, global hotkeys, and `prcockpit://` links.
- `relay/`: the Cloudflare Worker that receives GitHub webhook events and hands them to a cockpit.
- `scripts/`: install, launch, update, and the `pr-cockpit` CLI.

## Working here

- `bun install` at the repository root, in `ui/`, and in `shell/`.
- `cd ui && bun run dev` for a hot-reloading UI. It proxies `/api` to `127.0.0.1:4820`, so it needs a server on that port.
- `bun test server/<file>.test.ts` for a targeted test. Prefer targeted runs over the whole suite while iterating.
- Screenshot harnesses render at `1600x1200`; keep their default viewport and PNG dimension checks aligned.
- PR detail headers and tabs use the standard width; Conversation centers its 816px primary column and adjacent sidebar beneath them, and Files alone expands to full width.
- Verify landing-page search queries against live GitHub results; captured PR titles can disappear from the search index while the fixture remains valid.
- Match the surrounding style. Comments are for a non-obvious constraint, not for narration.
- Pull-request actions follow GitHub semantics: merge green, update neutral, and destructive actions red.
- Workflow jobs use commit-check semantics: green check for success, red cross for failure, orange spinner while active, and gray minus when skipped. Logs preserve ANSI colors and open at the bottom. Commit status icons open Cockpit’s Actions tab at that exact SHA; its selector covers the full mirror range, not GraphQL’s last 100 commits.
- Operational telemetry belongs on a top-level page, not in Settings; Usage keeps three days of hourly context and forecasts the active GitHub quota window.
- File status lives in the colored leading icon; moved files use a distinct move glyph, never a text badge beside the name.
- Agents mutate existing PRs through `pr-cockpit`; use its `--body-file` commands for exact multiline text, never `gh` or direct GitHub APIs.
- Do not perform Vercel or `forge.scape.app` infrastructure work from this repository.
- For manual app recordings, launch `/Users/theo/dev/pr-cockpit`; this `pr-cockpit-v3` checkout is the legacy landing worktree.

## Pull requests

- Functionality, themes, and small UI-polish fixes are welcome.
- New functionality defaults off. Styling is opt-in unless it is minor polish that preserves the default appearance.
- Every pull request includes before-and-after screenshots showing its effect in the app.

## Restarting the local server

`scripts/cockpit` is the full launcher: it builds if needed, starts the server only when it is down, and opens the Electron shell. Do not use it when the request is specifically to restart only the server.

Server environment:

```sh
COCKPIT_PORT=4820                                  # HTTP port
COCKPIT_DATA_DIR="$HOME/.local/share/pr-cockpit"   # SQLite cache, images, queued actions
COCKPIT_REPOS="owner/repo,owner/other-repo"        # seeds tracked repos on first launch
COCKPIT_PROXY="scape-agent"                        # optional Cockpit replica source over SSH
COCKPIT_PROXY_PORT=4820                            # Cockpit port on that SSH host
```

`COCKPIT_MANAGED=1` is exported by `scripts/cockpit` and read by the Electron shell, not the server. It marks the installed instance so a dev launch stays isolated from it.

Replica mode keeps the Bun server, SQLite cache, UI, Electron shell, and image fetches on the Mac. `scripts/cockpit --use-as-proxy HOST` and `pr-cockpit --use-as-proxy HOST ...` tunnel the remote Cockpit API, replicate its inbox state, and disable local GitHub API access. A replica outage must surface as an outage, never fall back to local polling, and local install or quit paths must never shut down the remote server.
Before pushing replica or server-topology changes, verify the installed Electron app, image rendering, and CLI against the intended backend.

Runbook:

The installed backend runs from the `app.pr-cockpit.server` launch agent. Check with `launchctl list | grep cockpit`; the separate `app.pr-cockpit` entry is the renderer and must be left alone.

1. Launch-agent managed: `launchctl kickstart -k gui/$(id -u)/app.pr-cockpit.server`. This restarts it under launchd with the plist's own environment, which a hand-rolled `bun server/main.ts` will not reproduce. The kickstart call can take a minute, so run it in the background rather than assuming it hung.
2. Not managed (no `launchctl` entry): identify the listener with `lsof -nP -iTCP:<port> -sTCP:LISTEN`, because some agent sandboxes make `pgrep` fail even when the process exists. Stop only that PID with `kill -TERM <pid>`, then start `bun server/main.ts` with the environment above. In an agent terminal, keep the server's exec session alive; a detached `nohup` child from a one-shot tool shell may be cleaned up when that shell exits. The managed backend restarts after failures but not after a deliberate clean shutdown.
3. Verify with `curl -fsS -i http://127.0.0.1:<port>/healthz`. A healthy response is `200` with `root`, `lastPollAt`, and `prCount`. Note that `lastPollAt` is `null` immediately after a restart until the first poll completes.

A restricted sandbox can reject loopback `curl` even while the server is listening, so confirm with a less restricted local check before concluding the server is down. A listening port alone is also not evidence of healthy GitHub ingestion: for an update outage, force `POST /api/refresh`, verify that `lastPollAt` advances, and use `prCount` to confirm the cache is populated as expected.

Startup may log that a GitHub webhook hook already exists. That can break a webhook forwarding subprocess without preventing the Bun server itself from serving `/healthz`. Report the distinction accurately and do not call a restart failed solely because of that warning.

## Running a second instance

Never take over the port or data directory of a cockpit somebody is using. Start your own:

```sh
COCKPIT_PORT=4899 COCKPIT_DATA_DIR=/tmp/pr-cockpit-scratch bun server/main.ts
```

Stop it when you are done. `COCKPIT_MOCK=1` seeds a fixture database instead of talking to GitHub and requires an explicit `COCKPIT_DATA_DIR`. For captured fixtures, point `COCKPIT_MOCK_DATA` at the directory containing `snapshot.json`; referenced attachment files belong in its `blobs/` directory.

## Known test flakes

`bun test server/` runs the whole directory in one process and two tests flake there regardless of your change: `webhooks.test.ts` "migrates legacy window-keyed registrations" and `updateHandoff.test.ts` "new source launcher finishes an old updater's installation handoff once". Both pass when their file is run alone. Confirm a suspected regression by running the single file before believing the directory run.

## Verifying the installer

`scripts/bootstrap` and `scripts/install` run under `set -euo pipefail`, so a helper ending in `[[ cond ]] || return` propagates the failed test and aborts the whole install with no message. Always write `return 0`.

Walk both install paths before trusting a change: `COCKPIT_BOOTSTRAP_DRY_RUN=1 COCKPIT_HOME=/tmp/some-path scripts/bootstrap` must reach stage `3/3`, and a fake `HOME`/`PATH` fixture covers the legacy migration. A silent exit before the last stage is the signature of the bug above.

## Durable lessons

After a task needs non-obvious investigation, repeated failed attempts, or a recovery procedure, capture the lesson before handoff:

- Agent workflow, operational runbooks, and environment traps go here.
- A reproducible code failure gets an automated test instead of a paragraph.
- Record only evidence-backed, reusable guidance. No credentials, no transient PIDs, no diary of one-off failures.
- GitHub prerequisite and onboarding flows are server-classified and resolved in-app; never send users to Terminal. Match the landing page: one short headline, no subtitle, flat controls, and only copy needed for the next action; open browser setup automatically and retain the device code as recovery.
- GitHub GraphQL calls are attributed by feature and operation in Settings → General. External-client usage appears only after one complete locally tracked quota window; before then it is unknown, never estimated.
- Conflict cards refresh the mirror and compare the PR head with the current base branch; never use cached base revisions, invent repository-level conflict copy, or offer copy-prompt controls.
- Installed updates replace shell files without changing the running Electron process. Renderer code must tolerate the prior shell response shape until relaunch; verify shell changes in a separate fresh process and never restart the installed renderer.
- The Forgejo host mounts `/run` with `noexec`; invoke migration helpers through `bash` or `python3` rather than executing files there directly.
- Forgejo hides pull requests when `repository.is_mirror` is true even if the unit is enabled. Keep the `mirror` row, clear only `is_mirror`, limit its refspecs to heads and tags, and maintain each native PR's hidden `refs/pull/<N>/head`; create an ordinary fallback branch only for an active fork PR and write both refs as UID/GID `994:984`.
- Long authenticated browser benchmarks run one measured process at a time. Retry and discard only transport-failed iterations, checkpoint each complete product sample set under `.scratch`, and publish only after every product reaches the declared successful sample count.
- A phone reaches a hosted cockpit through a mesh VPN whose agent runs on the same host: the Twingate Connector shares the host network namespace, so the Resource keeps address `127.0.0.1` with TCP restricted to the cockpit port, and the alias origin must be added to `COCKPIT_ALLOWED_ORIGINS` or the event socket and every unsafe request return `403`. A new Resource is visible per identity, so `twingate resources` on one host can omit a Resource that another account already reaches; verify from the account that will use it.

Keep entries short and current. When a new procedure supersedes an old one, replace the old instruction rather than leaving conflicting advice.
