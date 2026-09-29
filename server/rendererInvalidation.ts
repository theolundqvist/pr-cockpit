export type RendererInvalidation =
  | { type: "poll-complete"; lastPollAt: string }
  | { type: "inbox" }
  | { type: "pr"; repo: string; number: number }
  | { type: "notifications" }
  | { type: "notification-settings" }
  | { type: "settings" };

let publish = (_event: RendererInvalidation): void => {};

export function setRendererInvalidationPublisher(next: (event: RendererInvalidation) => void): void {
  publish = next;
}

export function invalidateInbox(): void {
  publish({ type: "inbox" });
}

export function publishPollCompleted(lastPollAt: string): void {
  publish({ type: "poll-complete", lastPollAt });
}

export function invalidatePr(repo: string, number: number): void {
  publish({ type: "pr", repo, number });
}

export function invalidateNotifications(): void {
  publish({ type: "notifications" });
}

export function invalidateNotificationSettings(): void {
  publish({ type: "notification-settings" });
}

export function invalidateSettings(): void {
  publish({ type: "settings" });
}
