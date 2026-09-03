import { DEFAULT_SENTRY_DSN } from "../shared/sentry.ts";

export interface InstallFailure {
  stage: string;
  status: number;
  platform: string;
}

function envelopeEndpoint(dsn: URL): URL {
  const path = dsn.pathname.split("/").filter(Boolean);
  const projectId = path.pop();
  if (!dsn.username || !projectId) throw new Error("invalid Sentry DSN");
  return new URL(`${path.length ? `/${path.join("/")}` : ""}/api/${projectId}/envelope/`, dsn.origin);
}

export async function reportInstallFailure(
  failure: InstallFailure,
  dsn = Bun.env.COCKPIT_SENTRY_DSN ?? DEFAULT_SENTRY_DSN,
): Promise<void> {
  if (dsn === "") return;
  try {
    const eventId = crypto.randomUUID().replaceAll("-", "");
    const sentAt = new Date().toISOString();
    const event = {
      event_id: eventId,
      timestamp: sentAt,
      level: "error",
      platform: "javascript",
      logger: "pr-cockpit.installer",
      message: `Installation failed during ${failure.stage} (exit ${failure.status})`,
      tags: {
        component: "installer",
        install_stage: failure.stage,
        install_status: String(failure.status),
        install_platform: failure.platform,
      },
    };
    const body = [
      JSON.stringify({ event_id: eventId, dsn, sent_at: sentAt }),
      JSON.stringify({ type: "event" }),
      JSON.stringify(event),
    ].join("\n");
    await fetch(envelopeEndpoint(new URL(dsn)), {
      method: "POST",
      headers: { "content-type": "application/x-sentry-envelope" },
      body,
      signal: AbortSignal.timeout(2_000),
    });
  } catch {}
}

if (import.meta.main) {
  const [stage = "unknown", status = "1", platform = process.platform] = process.argv.slice(2);
  await reportInstallFailure({ stage, status: Number(status) || 1, platform });
}
