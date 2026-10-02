# PR Cockpit

**An extremely fast GitHub for pull request review.** PRs open in 20 ms instead of 1.4 s ([benchmark](docs/BENCHMARKS.md)).

PR Cockpit is a desktop app for GitHub pull requests on **macOS and Linux**. A local mirror, kept current by webhooks, holds every PR you care about, so the queue, the diff, the failed check logs and the review threads paint from disk. Keyboard for everything; GitHub stays the source of truth.

[Install](#install) · [See the workflow](#from-finding-the-pr-to-finishing-the-review) · [CLI for humans and agents](#the-same-pr-context-in-your-terminal) · [Website](https://prcockpit.com/)

![PR Cockpit showing the review queue for microsoft/vscode, grouped into ready to merge and waiting](docs/screenshots/landing-inbox.png)

The queue separates **ready to merge**, **your move**, and **waiting**. Failed merge attempts appear under **FAILED TO MERGE** above pinned PRs in every grouping mode, until retried, dismissed, merged, or closed. Checks, conflicts, unresolved threads, and review state give you the context to decide what to open next. Stacked pull requests stay together.

## Install

Run this in your terminal as your normal user, **not with `sudo`**:

```sh
curl -fsSL https://raw.githubusercontent.com/theolundqvist/pr-cockpit/main/scripts/bootstrap | bash
```

[Read the installer first](scripts/bootstrap). It checks prerequisites, installs the desktop app and `pr-cockpit` CLI, and opens setup. On macOS it offers to install missing tools where supported; on Linux it checks system prerequisites and installs missing Bun and GitHub CLI tools into the managed installation.

**Supported platforms:** macOS and Linux. Linux requires systemd and the desktop libraries listed by the installer; x64 and arm64 are supported. X11 is supported directly; Wayland uses XWayland, and global shortcuts depend on compositor policy. Windows is not supported.

### Try it on a PR you already know

- **Connect GitHub in the app.** Cockpit reuses your GitHub CLI (`gh`) login. If you need to sign in or grant additional access, setup opens the GitHub authorization flow in your browser.
- **Choose a repository you work in.** Start with an open PR you've authored or participated in. **Open** follows PRs involving you; **All PRs** shows every open PR in your selected repositories. You can enter `owner/repo` if it is not in the suggested list.
- **Enable live updates, or continue with polling.** Live updates use a GitHub App installation with access to your selected repositories. An organization may require an owner's approval; that need not block your first review.
- **Open the queue and pick that PR.** Read the conversation, press <kbd>d</kbd> to switch to Files, and inspect a change. Press <kbd>?</kbd> whenever you want the shortcut guide.

The first sync fetches PRs involving you. **All PRs** loads on demand without expanding background polling. Press <kbd>Tab</kbd> to cycle Open, All PRs, and Recently merged. Repository and live-update configuration live in Settings.

Press <kbd>r</kbd> to filter repositories. Use arrows to highlight one, <kbd>Enter</kbd> to toggle it, or <kbd>Shift+Enter</kbd> to select only that repository.

## From finding the PR to finishing the review

### Bring up a PR without leaving your editor

Press <kbd>⌥⌘K</kbd> on macOS or <kbd>Super+Alt+K</kbd> on Linux X11 to search from another app. Move the pointer or use the arrow keys to select a result; Enter opens that highlighted result in Cockpit, with the cached PR ready to read. Typing a number such as `51` or `#51` lists that exact PR first, then PRs whose numbers contain it, open before closed and highest first, so `51` also finds `#10051`.

![Searching for a public rust-lang/rust pull request from the desktop and opening it in PR Cockpit](docs/screenshots/landing-search.gif)

### Read the change, then follow the details

Diffs, threads, checks, and file history live in the same review workspace. The PR check summary uses the latest workflow run and job attempt; earlier runs remain in Actions history. Press <kbd>x</kbd> to fold test files when you want to see the implementation first; press it again to bring the tests back.

![Folding five regression-test diffs in graphql/graphql-js#4692 to isolate the one-line implementation change](docs/screenshots/landing-hide-tests.gif)

When the review needs a change, stay in context: <kbd>e</kbd> edits the open file and commits the patch to the PR; <kbd>p</kbd> opens the PR in your configured coding agent with review context. You can also revert a focused hunk or press <kbd>h</kbd> to inspect file history. A failed merge immediately requests fresh PR details to reveal conflicts or other blockers, while keeping the original error available to retry or dismiss.

Reviewer badges show scores explicitly posted in reviews or comments, parsed without launching a scoring agent.

Enable **Pending reviews** in **Settings → Workspace** to save inline comments as a native GitHub draft and submit them together as one review. Drafts survive reloads and remain editable; if the PR head changes, submission stops until the stale draft is discarded. **Comment now** still posts a single comment immediately.

Enable **Mark changed descriptions** in **Settings → Workspace** to show a small blue dot to the left of the avatar, vertically centered on it, when the PR description differs from the one you last read. It is off by default. A description counts as read while it is on screen in the Conversation tab of a foreground window; PRs you have never read stay unmarked, and a description reverted to the version you read clears the dot.

Enable **Approve PRs for safe merge** in **Settings → Workspace**, then right-click a PR and choose **Approve for safe merge**. It appears above ordinary pins, below failed merges, without launching an agent. Approval covers that PR through fixes and base updates until revoked; closing it or disabling the feature clears approval. Ordinary pins remain bookmarks.

Enable **Rename and move PRs between groups** in **Settings → Workspace** to rename a PR from its right-click menu or move it onto another section or row. Rename edits the title inline: Enter saves and Escape cancels. Type grouping changes the title's conventional-commit type; feature grouping changes its scope; manual grouping changes only your assignment. Dragging preserves the summary, draft prefix, and breaking-change marker. Status sections remain read-only. Dropping into **Approved for safe merge** grants approval; dropping out revokes it.

Press **⌘Z** (Ctrl+Z on Windows/Linux) to undo a title change from Rename or a group move, including while it is saving. Undo restores the exact previous title on GitHub, not revoked merge approval. Title changes and Set Aside share undo order; text fields and the whiteboard keep their own undo.

Desktop notifications are off by default. In **Settings → Notifications**, choose events and combine rules for human or bot authors, comment text, repositories, and review requests. GitHub bot accounts and configured review bots count as bots; unknown authors match neither human nor bot filters.

<details>
<summary><strong>Everyday shortcuts</strong></summary>

| Key | Action |
| --- | --- |
| <kbd>j</kbd> / <kbd>k</kbd> | Move |
| <kbd>enter</kbd> / <kbd>esc</kbd> | Open / back |
| <kbd>d</kbd> | Conversation / Files |
| <kbd>c</kbd> / <kbd>r</kbd> | Comment / reply |
| <kbd>p</kbd> | Open in the configured agent |
| <kbd>e</kbd> | Edit the open file |
| <kbd>x</kbd> | Hide / show test files |
| <kbd>h</kbd> | File history |
| <kbd>m</kbd> | Merge |
| <kbd>⌘</kbd><kbd>z</kbd> / <kbd>Ctrl</kbd><kbd>z</kbd> | Undo a group-move rename or Set Aside action |
| <kbd>?</kbd> | Full shortcut guide |

</details>

### Keep personal review context on a whiteboard

Enable **Whiteboard (Experimental)** in **Settings → Workspace** to add the final review-queue tab. It is off by default. One personal canvas is saved in this installation's SQLite database; disabling the setting keeps it and stops board activity in every connected window. Unsaved work stays protected in its window with a visible export/re-enable banner; keep that window open until recovered. Board actions never change GitHub, manual queue groups, or queue order.

Open PRs, including drafts, start in sections based on your queue grouping, arranged to fit the canvas proportions. **Arrange** refreshes inbox-generated groups from the current queue, removes empty sections, and reflows the board; Undo restores the previous grouping and positions. Custom sections and their cards stay personal. Rename a generated section to make it personal. Cards outside the current queue remain under **On this board**. Ordinary refreshes and window resizing preserve your layout. Drag cards on the 16 px grid, Shift-click or drag empty space to select several objects, and move a section to carry its contents. Add personal notes, pen strokes and connectors with the toolbar. Double-click a card to open its real PR; returning keeps your location and selection. New PRs arrive below existing objects without rearranging them. New commits flag cards for another look; missing cached PRs keep clearly marked last-known metadata. Live metadata refreshes do not create personal saves. Clean windows adopt newer saved boards; unsaved edits require explicit conflict resolution.

**Scroll** zooms at the pointer; hold **Space** and drag to pan. Tool shortcuts are **V** select, **H** pan, **F** section, **P** pen, **T** note, and **C** connector, also shown beside each tool. **1** fits the board, **0** restores 100%, and **/** finds and locates objects. Arrows nudge the selection; **Delete** removes only board objects. **Ctrl/⌘ Z** and **Shift Ctrl/⌘ Z** undo/redo within the current session, without rolling back live PR metadata. Text editors retain their native text shortcuts. **Clear completed** removes closed/merged cards from the board only; it is undoable and those cards stay excluded on refresh. **Export** downloads a board backup. Failed saves and conflicting windows keep local edits and offer explicit retry/recovery controls.

## The same PR context in your terminal

The included `pr-cockpit` CLI reads the same local cache as the app. Use it yourself, or give your coding agent a way to inspect a PR without repeatedly fetching it from GitHub. Set up the app first; the CLI needs the local Cockpit server.

Replace `owner/repo#123` with your pull request:

```sh
pr-cockpit owner/repo#123                   # state, checks, and review threads
pr-cockpit owner/repo#123 --diff            # cached unified diff
pr-cockpit owner/repo#123 --file src/app.ts # file contents at the PR head
pr-cockpit owner/repo#123 --jobs            # queued, running, and completed jobs
pr-cockpit owner/repo#123 --logs            # cached failed and cancelled job logs
pr-cockpit owner/repo#123 --logs verify --run 987 --attempt 2
```

`--run` selects a cached run even after the PR head advances; `--attempt` selects its rerun attempt. Without these selectors, jobs and logs use the current head.

**Waiting on CI or a review? Listen instead of polling.**

```sh
pr-cockpit listen owner/repo#123
```

`listen` waits for substantive cached state changes—a push, check result, review, comment, or merge conflict—then prints what changed and exits. It returns at once when the PR already has failing checks, open comments, or merge conflicts. `--ci-only`, `--comments-only`, and `--conflicts-only` narrow the wake signal.

`pr-cockpit listen owner/repo#123 --run 987` waits for a specific run and reconciles it about every 30 seconds at the default interval, so missed webhooks cannot leave completion unobserved. A failed reconciliation exits with an error.

The CLI also supports comments, reviews, thread resolution, edits, and merges through Cockpit's mutation queue. Run **`pr-cockpit --help`** for commands and options, including `--body-file` for exact multiline text and `--json` for machine-readable status. The installer separately asks before adding Cockpit instructions to supported coding assistants.

Built-in agents launch from Cockpit's cached PR brief without spending GitHub API quota, and clone through Git rather than GitHub's API. They use `pr-cockpit` for PR reads and mutations; remote API operations still need available quota. With OMP, Opus uses the `opus` alias and Sonnet uses `anthropic/claude-sonnet-5-5`.

Arming auto-merge approves the feature and delegates safely landing it to the merger. It follows your global and repository instructions, addressing comments, conflicts, and CI failures caused by the PR; known unrelated failures need no rerun or post-merge proof. OMP loads global instructions automatically, and the agent reads repository instructions after cloning. A direct prompt can also authorize merging explicitly. In either case, Cockpit refreshes the PR and merges only the head the agent checked. Bypassing required GitHub checks or approvals still needs the repository's force-merge opt-in; conflicts, unresolved threads, and changes-requested reviews remain blockers.

Safe-merge approval is also visible in CLI output and as `approvedForSafeMerge` in `--json`; `listen` wakes when it changes. Agents must re-read approval immediately before merging and still satisfy the safety checks above. Approval is granted or revoked in the app, never by an agent approving itself.

The Agents tab renders Markdown answers, groups tool activity into expandable details, and shows an identical final-answer echo only once. Full tool inputs, errors, and raw logs remain available.

Enable **Quick Generate** in **Settings → Agents & merging** to draft text from anywhere with <kbd>⌥⌘J</kbd> on macOS or <kbd>Super+Alt+J</kbd> on Linux X11. Choose an API key and model, write a prompt, then press <kbd>⌘Enter</kbd> to generate. Results render Markdown with Cockpit’s syntax-highlighted code blocks; **Copy** keeps the original Markdown. Closing the prompt keeps its draft and result. Updating an older desktop shell requires a normal relaunch for the global shortcut.

Keys are detected from `$XDG_CONFIG_HOME/.env` (or `~/.config/.env`), then `~/.env`, then the Cockpit server's environment; the first nonempty value wins. **API key file** selects a different file and accepts absolute paths, `~/`, `$HOME`, or `$XDG_CONFIG_HOME`. A missing selected file shows an error instead of falling back. Supported names are `CEREBRAS_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, and `GROQ_API_KEY`; suffixes such as `CEREBRAS_API_KEY_WORK` provide additional choices. Credentials stay on the Cockpit host and go only to their provider, including in replica mode. Models come from the provider's catalog, with Cerebras Qwen preferred by default.

**Settings → Usage** shows REST core and GraphQL quota separately, including exhausted balances and reset times. Reading quota status remains available when the primary REST limit is exhausted; GitHub's secondary cooldowns still apply.

## Local reads. GitHub authority.

Cockpit is a client for your existing GitHub workflow, not a second place to maintain pull requests.

- **On your machine:** a Bun server maintains a SQLite cache of PR state and serves the desktop UI and CLI. Diffs, threads, checks, and images are cached locally.
- **Mirror storage:** Git mirrors compact automatically and evict the oldest unprotected caches toward a 20 GiB target. Active reads, recent use, and linked worktrees are protected, so the target is not a hard limit.
- **Back to GitHub:** comments, reviews, file edits, thread resolution, and merges use your GitHub CLI authentication. GitHub remains authoritative.
- **Keeping it current:** the hosted relay is enabled by default. It receives GitHub webhooks and delivers compact change markers and Actions run/job state, including runner assignment—not full PR contents or job logs—to Cockpit. Branch pushes refresh open PRs whose head or base matches, including recently viewed PRs outside the inbox. A direct GitHub poller repairs missed events.
- **Your relay, if you prefer:** you can configure a different relay URL. See [Self-hosting](docs/self-host-relay.md) for deployment and connection instructions.

Local caching does **not** mean the app makes no external connections. Besides GitHub and the relay, the backend has [Sentry error reporting enabled by default](server/sentry.ts).

<details>
<summary><strong>Updates, diagnostics, and configuration</strong></summary>

In **Settings → Workspace → Developer**, choose **Check for updates** to fetch the latest `main` revision from GitHub. If an update is available, **Install update** runs the existing updater; the page reloads when the server reports the new revision. Installations with updates disabled reject both actions.

If the installed backend cannot start, the desktop launcher automatically tries an update before opening the app. Recovery is limited to once every five minutes, respects disabled updates, and leaves local edits and non-`main` branches untouched. It restarts only the backend, never an already-running desktop window. If no working update is available, startup reports the failure.

```sh
pr-cockpit update  # update and reconcile the installed app
pr-cockpit status  # identify the process supervising the local server
```

The installer manages the background server and desktop integration. On Linux, `$HOME/.pr-cockpit/scripts/uninstall` removes a default installation; adding `--purge` also removes its local data.

Use Settings for day-to-day configuration. Optional shell overrides live in `~/.config/pr-cockpit/config` (Linux respects `XDG_CONFIG_HOME`).

| Variable | Purpose |
| --- | --- |
| `COCKPIT_REPOS` | Comma-separated `owner/repo` list |
| `COCKPIT_PORT` | Local HTTP port; defaults to `4820` |
| `COCKPIT_DEFAULT_REPO` | Repository assumed when a PR number is passed alone |
| `COCKPIT_REPO_ROOTS` | Paths containing local checkouts |
| `COCKPIT_RELAY_URL` | Custom webhook relay URL |
| `COCKPIT_TAILSCALE_SERVE` | Set to `1` to publish Cockpit privately through Tailscale Serve |
| `COCKPIT_TAILSCALE_HTTPS_PORT` | Tailscale HTTPS port; defaults to `443` |

</details>

## Contribute

Found friction in a real review? [Open an issue](https://github.com/theolundqvist/pr-cockpit/issues) with what you were trying to do and what got in the way. Keep reports and screenshots free of private repository data.

Fixes, functionality, themes, and UI polish are welcome. Read the [contributor and agent guide](AGENTS.md) for development setup and repository conventions. New functionality must default off; styling must be opt-in unless it is minor polish that preserves the default appearance. Pull requests must include before-and-after screenshots showing their effect in the app.

[MIT licensed](LICENSE).
