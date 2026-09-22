import * as Sentry from "@sentry/bun";
import { DEFAULT_SENTRY_DSN } from "../shared/sentry.ts";
import { runningRev } from "./version.ts";

export function sentryEnvironment(): "production" | "development" | "test" {
  if (Bun.env.NODE_ENV === "test" || Bun.env.COCKPIT_MOCK === "1") return "test";
  return Bun.env.COCKPIT_SUPERVISOR ? "production" : "development";
}

// explicit empty-string env means Sentry off — only absence falls through to the default
export function startSentry(): void {
  const dsn = Bun.env.COCKPIT_SENTRY_DSN ?? DEFAULT_SENTRY_DSN;
  if (dsn === "") return;
  Sentry.init({
    dsn,
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
