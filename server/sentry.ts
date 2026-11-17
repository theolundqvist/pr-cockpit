import * as Sentry from "@sentry/bun";
import { DEFAULT_SENTRY_DSN } from "../shared/sentry.ts";
import { runningRev } from "./version.ts";
import { errorReportsEnabled } from "./settings.ts";

export function sentryEnvironment(): "production" | "development" | "test" {
  if (Bun.env.NODE_ENV === "test" || Bun.env.COCKPIT_MOCK === "1") return "test";
  return Bun.env.COCKPIT_SUPERVISOR ? "production" : "development";
}

let managed = false;
let active = false;

// Opt-in: the SDK is initialized only while error reports are on, so an uninitialized SDK drops every capture.
export function startSentry(): void {
  managed = true;
  void applyErrorReportsSetting();
}

// Settings saves await this so turning reports on or off takes effect without a restart. The client keeps sending
// until close() has flushed its queue, so the save returns only after that.
export async function applyErrorReportsSetting(): Promise<void> {
  if (!managed || errorReportsEnabled() === active) return;
  active = !active;
  if (!active) {
    await Sentry.close(2_000);
    return;
  }
  Sentry.init({
    dsn: Bun.env.COCKPIT_SENTRY_DSN ?? DEFAULT_SENTRY_DSN,
    release: runningRev() || undefined,
    environment: sentryEnvironment(),
    integrations: [Sentry.dedupeIntegration()],
    sendDefaultPii: false,
  });
}

export function captureError(error: unknown, operation: string): void {
  const exception = error instanceof Error ? error : new Error(String(error));
  Sentry.withScope((scope) => {
    scope.setTag("operation", operation);
    Sentry.captureException(exception);
  });
}

export async function captureFatal(error: unknown): Promise<void> {
  Sentry.captureException(error);
  await Sentry.flush(2000).catch(() => {});
}
