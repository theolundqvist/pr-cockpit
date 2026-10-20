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

// Keep launch bridges intact; a desktop download is not an app-opening link.
export function previewCommentLinks(comments) {
  const latest = new Map();
  for (const comment of comments) {
    if (comment.author?.__typename !== "Bot") continue;
    const buttons = [...comment.body.matchAll(BUTTON_LINK)].map(([, label, url]) => ({ label, url }));
    const web = buttons.filter(({ label }) => /^(?:open |web |open web )?preview$/i.test(label.trim()));
    const desktop = buttons.filter(({ label }) => /^(?:open )?desktop(?: app| preview)?$/i.test(label.trim()));
    // Older preview publishers use a Web link and a named "Open in … Preview" link.
    const plainWeb = /\bWeb:\s*\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/i.exec(comment.body);
    const bareWeb = /\bWeb:\s*<?(https?:\/\/[^\s,<>]+)>?/i.exec(comment.body);
    const plainDesktop = /\[(Open in [^\]]*Preview)\]\((https?:\/\/[^)\s]+)\)/i.exec(comment.body);
    if (plainWeb && /preview/i.test(comment.body)) web.push({ label: plainWeb[1], url: plainWeb[2] });
    if (!plainWeb && bareWeb && /preview/i.test(comment.body)) web.push({ label: "Web preview", url: bareWeb[1] });
    if (plainDesktop) desktop.push({ label: plainDesktop[1], url: plainDesktop[2] });
    if (!web.length && !desktop.length) continue;
    latest.set(comment.author.login, [
      ...web.map((link) => ({ ...link, kind: "web" })),
      ...desktop.map((link) => ({ ...link, kind: "desktop" })),
    ]);
  }
  const seen = new Set();
  return [...latest.values()].flat().filter(({ url }) => !seen.has(url) && seen.add(url));
}
