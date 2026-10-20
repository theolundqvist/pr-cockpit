const BUTTON_LINK = /\[!\[([^\]]+)\]\([^)]*\)\]\((https?:\/\/[^)\s]+)\)/g;

/**
 * The image-button links (`[![label](badge)](url)`) of each bot's latest comment that has any: bots such as preview
 * deployers post their links as badge buttons and edit or repost that comment as their state changes.
 */
export function botCommentLinks(comments) {
  const latest = new Map();
  for (const comment of comments) {
    if (comment.author?.__typename !== "Bot") continue;
    const links = [...comment.body.matchAll(BUTTON_LINK)].map(([, label, url]) => ({ label, url }));
    if (links.length) latest.set(comment.author.login, links);
  }
  const seen = new Set();
  return [...latest.values()].flat().filter(({ url }) => !seen.has(url) && seen.add(url));
}
