export const GITHUB_MEDIA_HOSTS = new Set([
  "github.com",
  "private-user-images.githubusercontent.com",
  "raw.githubusercontent.com",
]);

// Markdown images, <img> and <video> sources, and GitHub's bare attachment line for an uploaded video.
// One alternation keeps matches in document order.
const MEDIA_RE = /!\[[^\]]*\]\(\s*<?([^)\s>]+)>?|<img\b[^>]*?\bsrc\s*=\s*["']([^"']+)["']|<video\b[^>]*?\bsrc\s*=\s*["']([^"']+)["']|^[ \t]*(https:\/\/github\.com\/user-attachments\/assets\/[0-9a-f-]+)[ \t]*$/gim;
// Fenced code and HTML comments never render, so their media is not attached to the PR.
const HIDDEN_RE = /<!--[\s\S]*?-->|^ {0,3}(`{3,}|~{3,})[\s\S]*?^ {0,3}\1/gm;

// Returns unique GitHub-hosted media URLs in document order; `videos: false` keeps only images.
export function extractGithubMedia(text: string, { videos }: { videos: boolean }): string[] {
  if (!text) return [];
  const urls = new Set<string>();
  for (const match of text.replace(HIDDEN_RE, "").matchAll(MEDIA_RE)) {
    const raw = match[1] ?? match[2] ?? (videos ? match[3] ?? match[4] : undefined);
    if (!raw) continue;
    try {
      const target = new URL(raw);
      if (target.protocol === "https:" && GITHUB_MEDIA_HOSTS.has(target.host)) urls.add(raw);
    } catch {}
  }
  return [...urls];
}
