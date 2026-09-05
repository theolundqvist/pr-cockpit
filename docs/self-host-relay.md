# Self-host a Cloudflare relay

The default hosted relay uses the [WebSocket server](../relay-server/). This guide deploys the optional [Cloudflare relay](../relay/): one Worker backed by one Durable Object, with no separate database, server, tunnel, or relay account.

The Cloudflare relay receives GitHub webhooks and stores at most 1,000 compact change markers. Each local PR Cockpit server polls this relay over authenticated HTTP every five seconds and can read only repositories its own GitHub token can access. This relay does not store full pull-request payloads or job logs; unlike the default hosted relay, it does not stream updates over WebSockets.

## Prerequisites

- A Cloudflare account
- [Bun](https://bun.sh/) installed
- Permission to create and install a GitHub App for the repositories you use
- PR Cockpit installed and connected to `gh`

## 1. Deploy the relay

Clone the repository and deploy the Worker:

```sh
git clone https://github.com/theolundqvist/pr-cockpit.git
cd pr-cockpit/relay
bun install
bunx wrangler login
bun run deploy
```

Wrangler prints a URL such as:

```text
https://pr-cockpit-relay.<your-subdomain>.workers.dev
```

Keep that URL. Confirm the Worker is reachable:

```sh
curl -fsS https://pr-cockpit-relay.<your-subdomain>.workers.dev/health
```

The response must be `ok`.

Create a webhook secret and add it to the Worker:

```sh
WEBHOOK_SECRET="$(openssl rand -hex 32)"
printf '%s' "$WEBHOOK_SECRET" | bunx wrangler secret put WEBHOOK_SECRET
```

Keep this terminal open until the GitHub App is created. The same value goes into its **Webhook secret** field.

## 2. Create the GitHub App

Create the app under the GitHub user or organization that owns the repositories:

- Personal account: open `https://github.com/settings/apps/new`.
- Organization: open `https://github.com/organizations/ORG/settings/apps/new`, replacing `ORG`.

Set:

| Field | Value |
| --- | --- |
| GitHub App name | Any unique name, such as `PR Cockpit Relay — Your Team` |
| Homepage URL | `https://github.com/theolundqvist/pr-cockpit` |
| Webhook | Active |
| Webhook URL | `<your Worker URL>/github` |
| Webhook secret | The value in `$WEBHOOK_SECRET` |

Leave callback URLs, OAuth authorization, and device flow disabled. PR Cockpit needs only webhooks; it does not need the app's client secret or a private key.

Under **Repository permissions**, select **Read-only** for:

- Actions
- Checks
- Commit statuses
- Contents
- Issues
- Metadata
- Pull requests

Subscribe to these events:

- Check run
- Check suite
- Issue comment
- Pull request
- Pull request review
- Pull request review comment
- Pull request review thread
- Push
- Status
- Workflow job
- Workflow run

Choose **Only on this account** when every repository belongs to the app owner. Choose **Any account** only when other users or organizations also need to install this relay. Then create the app.

## 3. Install the GitHub App

Open the new app's **Install App** page, choose the account, and grant access to all repositories or only the repositories tracked by PR Cockpit.

Organization policy may require an owner to approve the installation. The relay automatically records repository coverage from GitHub's installation webhook.

## 4. Connect PR Cockpit

In **Settings → Workspace**, expand **Update frequency & live updates**, enter the Worker URL without `/github` in **Live update relay**, and save:

```text
https://pr-cockpit-relay.<your-subdomain>.workers.dev
```

The local server picks up the new URL without a restart. Every teammate who should use this relay enters the same URL; each teammate still authenticates reads and writes with their own `gh` login.

For a managed or scripted installation, set the same URL in `~/.config/pr-cockpit/config` instead:

```sh
COCKPIT_RELAY_URL="https://pr-cockpit-relay.<your-subdomain>.workers.dev"
```

## 5. Verify live updates

1. In PR Cockpit settings, confirm each selected repository says **live push ✓**.
2. Comment on, push to, or change a check on an open pull request.
3. Confirm the relay status below **Live update relay** changes from waiting for the first event to a recent event time.
4. In the GitHub App's **Advanced → Recent deliveries**, confirm the delivery returned HTTP `200`.

The slower direct GitHub poller remains active as a repair path if the relay is unavailable or an event is missed.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `/health` does not return `ok` | Run `bun run deploy` again and use the exact URL printed by Wrangler. |
| GitHub delivery returns `401 bad signature` | Replace `WEBHOOK_SECRET` in Wrangler or the GitHub App so both values match. |
| Repository says `polling only` | Configure the app installation to include that repository, then redeliver the installation event or reinstall the app. |
| Run state updates but job state does not | Enable **Workflow job** and **Workflow run** events and grant **Actions: Read-only**. |
| Private-repository events never appear locally | Run `gh auth status` and confirm that login can read the repository. The relay filters every event against the caller's GitHub access. |

## Update or remove it

Update the Worker from the repository checkout:

```sh
git pull --ff-only
cd relay
bun install
bun run deploy
```

Wrangler preserves the webhook secret. To stop using the relay, clear **Live update relay** in PR Cockpit, uninstall the GitHub App, then remove the Worker from Cloudflare.