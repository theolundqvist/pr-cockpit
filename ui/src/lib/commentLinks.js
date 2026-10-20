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

// Only promote launch buttons from a bot that also publishes a web preview.
// Keep the published URL intact: desktop links often use an HTTPS launch bridge.
export function previewCommentLinks(comments) {
  const authors = new Set(comments.filter((comment) => comment.author?.__typename === "Bot").map((comment) => comment.author.login));
  return [...authors].flatMap((author) => {
    const links = botCommentLinks(comments.filter((comment) => comment.author?.login === author));
    const web = links.filter(({ label }) => /^(?:open |web |open web )?preview$/i.test(label.trim()));
    if (!web.length) return [];
    return [
      ...web.map((link) => ({ ...link, kind: "web" })),
      ...links.filter(({ label }) => /^(?:open )?desktop(?: app| preview)?$/i.test(label.trim()))
        .map((link) => ({ ...link, kind: "desktop" })),
    ];
  }).filter((link, index, links) => links.findIndex((other) => other.url === link.url) === index);
}
