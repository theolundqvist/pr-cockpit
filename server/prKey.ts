export const prKey = (pr: { repo: string; number: number }) => `${pr.repo}#${pr.number}`;
export const prKeyOf = (repo: string, number: number) => `${repo}#${number}`;
