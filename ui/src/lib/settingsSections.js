export const SETTINGS_SECTION_KEY = "cockpit:settings-tab";

export const SETTINGS_SECTIONS = [
  {
    id: "general",
    label: "Workspace",
    iconPaths: ["M4 6h5m4 0h7M4 12h9m4 0h3M4 18h3m4 0h9", "M9 4v4m4 2v4m-6 2v4"],
  },
  {
    id: "appearance",
    label: "Appearance",
    iconPaths: ["M12 3v2m0 14v2M3 12h2m14 0h2M5.6 5.6 7 7m10 10 1.4 1.4M18.4 5.6 17 7M7 17l-1.4 1.4", "M15.5 12a3.5 3.5 0 1 1-7 0 3.5 3.5 0 0 1 7 0Z"],
  },
  {
    id: "keybinds",
    label: "Keyboard shortcuts",
    iconPaths: ["M4 7h16v10H4z", "M7 10h.01M10 10h.01M13 10h.01M16 10h.01M7 13h10"],
  },
  {
    id: "tests",
    label: "Review preferences",
    iconPaths: ["m8 7-4 5 4 5m8-10 4 5-4 5M13.5 5l-3 14"],
  },
  {
    id: "automerge",
    label: "Agents & merging",
    iconPaths: ["M7 8.5h10v9H7zM9 5.5h6M12 5.5V3.5", "M9.5 12h.01m4.99 0h.01M10 15h4"],
  },
  {
    id: "usage",
    label: "Usage",
    iconPaths: ["M4 19V9m5 10V5m5 14v-7m5 7V3"],
  },
  {
    id: "advanced",
    label: "Connections",
    iconPaths: ["M4 6c0 1.7 3.6 3 8 3s8-1.3 8-3-3.6-3-8-3-8 1.3-8 3Zm0 0v6c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6"],
  },
  {
    id: "analytics",
    label: "Analytics",
    iconPaths: ["M4 19V9m5 10V5m5 14v-7m5 7V3", "M3 19h18"],
  },
];

export function normalizeSettingsSection(value) {
  return SETTINGS_SECTIONS.some((section) => section.id === value) ? value : "general";
}

export function settingsSectionHref(id) {
  return `#/settings/${normalizeSettingsSection(id)}`;
}
