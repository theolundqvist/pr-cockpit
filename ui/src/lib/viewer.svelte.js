export const viewer = $state({ login: null });

export function setViewerLogin(login) {
  viewer.login = login ?? null;
}
