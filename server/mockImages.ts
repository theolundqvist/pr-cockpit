function hash(input: string): number {
  let h = 2166136261;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function seededRandom(seed: number): () => number {
  let state = seed || 1;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function initials(login: string): string {
  const parts = login.split(/[-_.]+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0]![0]! + parts[1]![0]!).toUpperCase();
  const single = parts[0] ?? login;
  return single.slice(0, 2).toUpperCase();
}

export function mockAvatarSvg(login: string): string {
  const h = hash(login);
  const hue = h % 360;
  const hue2 = (hue + 25 + ((h >> 9) % 55)) % 360;
  const angle = (h >> 3) % 90;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="0 0 96 96">` +
    `<defs><linearGradient id="g" gradientTransform="rotate(${angle} .5 .5)">` +
    `<stop offset="0" stop-color="hsl(${hue} 68% 56%)"/>` +
    `<stop offset="1" stop-color="hsl(${hue2} 60% 42%)"/>` +
    `</linearGradient></defs>` +
    `<rect width="96" height="96" rx="48" fill="url(#g)"/>` +
    `<text x="48" y="50" text-anchor="middle" dominant-baseline="central" ` +
    `font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif" ` +
    `font-size="38" font-weight="600" fill="#fff" fill-opacity="0.96">${initials(login)}</text>` +
    `</svg>`;
}

export function mockAvatarDataUri(login: string): string {
  return `data:image/svg+xml;base64,${Buffer.from(mockAvatarSvg(login)).toString("base64")}`;
}

export function mockScreenshotSvg(seed: string): string {
  const h = hash(seed);
  const rand = seededRandom(h);
  const hue = h % 360;
  const accent = `hsl(${hue} 66% 58%)`;
  const accentSoft = `hsl(${hue} 45% 24%)`;
  const bg = "#0d1117";
  const panel = "#161b22";
  const raised = "#1f2630";
  const line = "#2a323d";
  const dim = "#3a4552";
  const W = 1200;
  const H = 760;

  const navItems = Array.from({ length: 6 }, (_, i) => {
    const y = 96 + i * 46;
    const w = 96 + Math.floor(rand() * 84);
    const active = i === Math.floor(rand() * 6);
    return `<rect x="28" y="${y}" width="20" height="20" rx="5" fill="${active ? accent : dim}"/>` +
      `<rect x="60" y="${y + 4}" width="${w}" height="12" rx="6" fill="${active ? accent : dim}" fill-opacity="${active ? 0.9 : 0.55}"/>`;
  }).join("");

  const stats = Array.from({ length: 3 }, (_, i) => {
    const x = 300 + i * 288;
    return `<rect x="${x}" y="96" width="264" height="104" rx="12" fill="${panel}" stroke="${line}"/>` +
      `<rect x="${x + 20}" y="120" width="${64 + Math.floor(rand() * 60)}" height="10" rx="5" fill="${dim}"/>` +
      `<rect x="${x + 20}" y="146" width="${90 + Math.floor(rand() * 70)}" height="24" rx="6" fill="${accent}" fill-opacity="0.85"/>`;
  }).join("");

  const barCount = 9;
  const bars = Array.from({ length: barCount }, (_, i) => {
    const bx = 320 + i * 84;
    const bh = 40 + Math.floor(rand() * 190);
    return `<rect x="${bx}" y="${560 - bh}" width="48" height="${bh}" rx="6" fill="${accent}" fill-opacity="${0.45 + rand() * 0.45}"/>`;
  }).join("");

  const rows = Array.from({ length: 4 }, (_, i) => {
    const y = 612 + i * 34;
    return `<circle cx="316" cy="${y + 10}" r="9" fill="${accentSoft}"/>` +
      `<rect x="336" y="${y + 4}" width="${180 + Math.floor(rand() * 260)}" height="12" rx="6" fill="${dim}"/>` +
      `<rect x="1010" y="${y + 4}" width="${40 + Math.floor(rand() * 90)}" height="12" rx="6" fill="${line}"/>`;
  }).join("");

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">` +
    `<rect width="${W}" height="${H}" rx="16" fill="${bg}" stroke="${line}" stroke-width="2"/>` +
    `<rect x="1" y="1" width="${W - 2}" height="48" rx="15" fill="${raised}"/>` +
    `<rect x="1" y="34" width="${W - 2}" height="15" fill="${raised}"/>` +
    `<circle cx="30" cy="25" r="7" fill="#ff5f57"/><circle cx="54" cy="25" r="7" fill="#febc2e"/><circle cx="78" cy="25" r="7" fill="#28c840"/>` +
    `<rect x="${W / 2 - 130}" y="17" width="260" height="16" rx="8" fill="${panel}"/>` +
    `<rect x="1" y="50" width="270" height="${H - 51}" fill="${panel}"/>` +
    `<line x1="271" y1="50" x2="271" y2="${H}" stroke="${line}"/>` +
    `<rect x="28" y="66" width="140" height="14" rx="7" fill="${accent}"/>` +
    navItems +
    `<rect x="300" y="230" width="840" height="286" rx="12" fill="${panel}" stroke="${line}"/>` +
    `<rect x="320" y="252" width="${160 + Math.floor(rand() * 120)}" height="14" rx="7" fill="${dim}"/>` +
    `<line x1="300" y1="560" x2="1140" y2="560" stroke="${line}"/>` +
    bars +
    rows +
    `</svg>`;
}
