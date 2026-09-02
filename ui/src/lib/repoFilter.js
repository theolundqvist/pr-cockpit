export function availableRepositories(configured, ...lists) {
  return [...new Set([...configured, ...lists.flat().map((pr) => pr.repo)].filter(Boolean))].sort();
}

export const filterByRepositories = (prs, repos) => repos.length ? prs.filter((pr) => repos.includes(pr.repo)) : prs;
