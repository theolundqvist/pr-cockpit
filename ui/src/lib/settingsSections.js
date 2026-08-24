export const SETTINGS_SECTION_KEY = "cockpit:settings-tab";

export const SETTINGS_SECTIONS = [
  {
    id: "general",
    label: "General",
    iconPaths: ["M4 6h5m4 0h7M4 12h9m4 0h3M4 18h3m4 0h9", "M9 4v4m4 2v4m-6 2v4"],
  },
  {
    id: "appearance",
    label: "Appearance",
    iconPaths: ["M12 3v2m0 14v2M3 12h2m14 0h2M5.6 5.6 7 7m10 10 1.4 1.4M18.4 5.6 17 7M7 17l-1.4 1.4", "M15.5 12a3.5 3.5 0 1 1-7 0 3.5 3.5 0 0 1 7 0Z"],
  },
  {
    id: "keybinds",
    label: "Keybinds",
    iconPaths: ["M4 7h16v10H4z", "M7 10h.01M10 10h.01M13 10h.01M16 10h.01M7 13h10"],
  },
  {
    id: "automerge",
    label: "Agents",
    iconPaths: ["M7 8.5h10v9H7zM9 5.5h6M12 5.5V3.5", "M9.5 12h.01m4.99 0h.01M10 15h4"],
  },
  {
    id: "tests",
    label: "Diff & Tests",
    iconPaths: ["m8 7-4 5 4 5m8-10 4 5-4 5M13.5 5l-3 14"],
  },
];

export function normalizeSettingsSection(value) {
  return SETTINGS_SECTIONS.some((section) => section.id === value) ? value : "general";
}

export function settingsSectionHref(id) {
  return `#/settings/${normalizeSettingsSection(id)}`;
}
