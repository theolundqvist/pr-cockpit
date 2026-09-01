import * as Sentry from "@sentry/bun";
import { runningRev } from "./version.ts";

// A DSN only authorizes event submission, never reads, so it ships in the repo.
const DEFAULT_SENTRY_DSN = "https://3e113f4ad1f2f61cb0d37a6c8162b76f@o4508884850311168.ingest.us.sentry.io/4512010382475264";

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
