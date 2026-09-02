export function availableRepositories(configured, ...lists) {
  return [...new Set([...configured, ...lists.flat().map((pr) => pr.repo)].filter(Boolean))].sort();
}

export const filterByRepository = (prs, repo) => repo ? prs.filter((pr) => pr.repo === repo) : prs;
