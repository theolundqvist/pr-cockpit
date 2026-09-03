import * as Sentry from "@sentry/bun";
import { DEFAULT_SENTRY_DSN } from "../shared/sentry.ts";
import { runningRev } from "./version.ts";

// explicit empty-string env means Sentry off — only absence falls through to the default
export function startSentry(): void {
  const dsn = Bun.env.COCKPIT_SENTRY_DSN ?? DEFAULT_SENTRY_DSN;
  if (dsn === "") return;
  Sentry.init({ dsn, release: runningRev() || undefined });
}

export async function captureFatal(error: unknown): Promise<void> {
  Sentry.captureException(error);
  await Sentry.flush(2000).catch(() => {});
}
