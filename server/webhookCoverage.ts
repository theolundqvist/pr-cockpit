// The relay client registers its coverage here, so Actions and poll code can ask without importing
// it (it imports them). Until it does, no repository counts as covered and everything polls.
let lookup: (repo: string) => number | null = () => null;

export function setWebhookCoverage(next: (repo: string) => number | null): void {
  lookup = next;
}

export function webhookCoverageSince(repo: string): number | null {
  return lookup(repo);
}
