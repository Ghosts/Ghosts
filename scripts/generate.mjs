// Renders the profile's live graphics from GitHub data: the hero (ASCII mark + terminal),
// the contribution pulse and one card per featured project, each in dark and light.
//
//   GITHUB_TOKEN=... node scripts/generate.mjs           fetch and render
//   node scripts/generate.mjs --fixture data.json        render from saved data

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NOISE, glyph, rasterize } from './mark.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ASSETS = join(ROOT, 'assets');
const LOGIN = 'Ghosts';
const OWNERS = ['Ghosts', 'Jackalope-Dev'];

/** Featured on the profile, in order. Copy is curated; numbers are live. */
const FEATURED = [
  {
    repo: 'Jackalope-Dev/jackalope',
    tag: 'flagship',
    stack: 'Rust · Tauri · React',
    blurb: [
      'Desktop workspace for coding agents. Run Claude Code,',
      'Codex and more in parallel worktrees, then review.',
    ],
  },
  {
    repo: 'Jackalope-Dev/all-mcps',
    tag: 'open directory',
    stack: 'Next.js · Cloudflare',
    blurb: [
      'The open directory for Model Context Protocol servers.',
      'Discover, evaluate and install 22,000+ MCP servers.',
    ],
  },
  {
    repo: 'Jackalope-Dev/allmcps-server',
    tag: 'mcp server',
    stack: 'TypeScript · MCP',
    blurb: [
      'Official AllMCPs MCP server. Search and submit servers',
      'to the directory straight from your AI agent.',
    ],
  },
  {
    repo: 'Jackalope-Dev/Moxie-Docs-MCP',
    tag: 'mcp + skills',
    stack: 'TypeScript · MCP',
    blurb: [
      'MCP server and agent skills for Moxie Docs, living',
      'documentation for private GitHub repositories.',
    ],
  },
];

const THEMES = {
  dark: {
    bg: '#0b0b0f',
    panel: '#111117',
    border: '#24232d',
    ink: '#f5f4f8',
    secondary: '#a6a2b8',
    tertiary: '#7c7891',
    muted: '#4a4759',
    accent: '#b9a6f2',
    accentStrong: '#8b74ec',
    glow: '#6d4fd8',
    echo: '#9b84f0',
  },
  light: {
    bg: '#faf9fc',
    panel: '#ffffff',
    border: '#e4e1ec',
    ink: '#16141d',
    secondary: '#55516a',
    tertiary: '#837e97',
    muted: '#c9c5d6',
    accent: '#6d4fd8',
    accentStrong: '#5a3cc9',
    glow: '#b9a6f2',
    echo: '#7c5ee0',
  },
};

const LANG_COLORS = {
  TypeScript: '#3178c6',
  JavaScript: '#f1e05a',
  Rust: '#dea584',
  CSS: '#663399',
  HTML: '#e34c26',
  Java: '#b07219',
  Svelte: '#ff3e00',
  MDX: '#fcb32c',
  Shell: '#89e051',
  Swift: '#F05138',
  Python: '#3572A5',
  'C#': '#178600',
};

const MONO = `ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace`;
const SANS = `-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Noto Sans', Helvetica, Arial, sans-serif`;
const CHAR = 0.6; // monospace advance in em; every text run gets textLength so fonts can't drift

// ── data ─────────────────────────────────────────────────────────────────────

async function graphql(query, variables = {}) {
  const token = process.env.PROFILE_TOKEN || process.env.GITHUB_TOKEN;
  if (!token) throw new Error('Set GITHUB_TOKEN (or PROFILE_TOKEN) to fetch live data.');
  const response = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: { authorization: `bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  const body = await response.json();
  if (!response.ok || body.errors) throw new Error(JSON.stringify(body.errors ?? body));
  return body.data;
}

function weekStarts(count, now = new Date()) {
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
  return Array.from({ length: count }, (_, index) => {
    const since = new Date(end - (count - index) * 7 * 864e5);
    const until = new Date(end - (count - index - 1) * 7 * 864e5);
    return [since.toISOString(), until.toISOString()];
  });
}

async function fetchData() {
  const weeks = weekStarts(16);
  const repoFields = (alias, nameWithOwner) => {
    const [owner, name] = nameWithOwner.split('/');
    const history = weeks
      .map(([since, until], index) => `w${index}: history(since: "${since}", until: "${until}") { totalCount }`)
      .join(' ');
    return `${alias}: repository(owner: "${owner}", name: "${name}") {
      nameWithOwner description stargazerCount forkCount pushedAt homepageUrl
      licenseInfo { spdxId } primaryLanguage { name color }
      defaultBranchRef { target { ... on Commit { ${history} } } }
    }`;
  };
  const all = FEATURED.map((item) => item.repo);
  const repos = await graphql(`{ ${all.map((repo, index) => repoFields(`r${index}`, repo)).join('\n')} }`);

  const { user } = await graphql(
    `query($login: String!) { user(login: $login) {
      name createdAt followers { totalCount }
      contributionsCollection {
        totalCommitContributions totalPullRequestContributions totalPullRequestReviewContributions
        totalIssueContributions restrictedContributionsCount totalRepositoriesWithContributedCommits
        contributionCalendar { totalContributions weeks { contributionDays { date weekday contributionCount contributionLevel } } }
      }
    } }`,
    { login: LOGIN },
  );

  // Languages across owned, non-fork public repos pushed in the last year.
  const languages = {};
  const yearAgo = Date.now() - 365 * 864e5;
  for (const owner of OWNERS) {
    const kind = owner === LOGIN ? 'user' : 'organization';
    const data = await graphql(
      `query($owner: String!) { ${kind}(login: $owner) {
        repositories(first: 100, privacy: PUBLIC, isFork: false, ownerAffiliations: OWNER) { nodes {
          pushedAt languages(first: 12, orderBy: { field: SIZE, direction: DESC }) { edges { size node { name color } } }
        } }
      } }`.replace('ownerAffiliations: OWNER', kind === 'user' ? 'ownerAffiliations: OWNER' : ''),
      { owner },
    );
    for (const repo of data[kind].repositories.nodes) {
      if (Date.parse(repo.pushedAt) < yearAgo) continue;
      for (const { size, node } of repo.languages.edges) {
        languages[node.name] ??= { size: 0, color: node.color };
        languages[node.name].size += size;
      }
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    user,
    languages,
    repos: Object.fromEntries(
      Object.values(repos).map((repo) => {
        const target = repo.defaultBranchRef?.target ?? {};
        const weekly = weeks.map((_, index) => target[`w${index}`]?.totalCount ?? 0);
        const { defaultBranchRef, ...rest } = repo;
        return [repo.nameWithOwner, { ...rest, weekly }];
      }),
    ),
  };
}

// ── helpers ──────────────────────────────────────────────────────────────────

const escape = (text) =>
  String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const fmt = (value) => value.toLocaleString('en-US');
const round = (value) => Math.round(value * 100) / 100;

/** A monospace run pinned to its grid width, so every font lines up the same. */
function mono(text, x, y, size, attrs = '') {
  const width = round([...text].length * size * CHAR);
  return `<text x="${round(x)}" y="${round(y)}" font-size="${size}" textLength="${width}" lengthAdjust="spacingAndGlyphs" ${attrs}>${escape(text)}</text>`;
}

/** Seeded so a re-render with the same data produces the same file (no churn commits). */
function random(seed) {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 2 ** 32;
  };
}

function ago(iso, now) {
  const days = Math.floor((Date.parse(now.slice(0, 10)) - Date.parse(iso.slice(0, 10))) / 864e5);
  if (days <= 0) return 'active today';
  if (days === 1) return 'active yesterday';
  if (days < 30) return `active ${days}d ago`;
  if (days < 365) return `active ${Math.floor(days / 30)}mo ago`;
  return `active ${Math.floor(days / 365)}y ago`;
}

function streaks(days) {
  let longest = 0;
  let run = 0;
  for (const day of days) {
    run = day.contributionCount > 0 ? run + 1 : 0;
    longest = Math.max(longest, run);
  }
  // Today may still be empty; the streak is alive until tomorrow.
  let current = 0;
  let index = days.length - 1;
  if (days[index]?.contributionCount === 0) index--;
  while (index >= 0 && days[index].contributionCount > 0) {
    current++;
    index--;
  }
  return { longest, current };
}

function svg(width, height, theme, body, extraStyle = '') {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img">
<style>
text { font-family: ${MONO}; fill: ${theme.ink}; white-space: pre; }
.sans { font-family: ${SANS}; }
.ink { fill: ${theme.ink}; } .sec { fill: ${theme.secondary}; } .ter { fill: ${theme.tertiary}; }
.mut { fill: ${theme.muted}; } .acc { fill: ${theme.accent}; } .strong { fill: ${theme.accentStrong}; }
@keyframes rise { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }
@keyframes fade { from { opacity: 0; } to { opacity: 1; } }
@keyframes gone { from { opacity: 1; } to { opacity: 0; } }
.rise { animation: rise 520ms cubic-bezier(.2,.7,.2,1) both; }
@media (prefers-reduced-motion: reduce) { * { animation: none !important; } }
${extraStyle}
</style>
<rect x="0.5" y="0.5" width="${width - 1}" height="${height - 1}" rx="14" fill="${theme.bg}" stroke="${theme.border}"/>
${body}
</svg>
`;
}

// ── hero ─────────────────────────────────────────────────────────────────────

/** When the first garble starts (after the intro decode), and how often it repeats. */
const GARBLE_START = 3600;
const GARBLE_STYLE = `
@keyframes settle {
  0%, 3% { opacity: 1; transform: none; }
  5% { opacity: .3; transform: translateX(1.5px); }
  7% { opacity: .08; transform: translateX(-1.5px); }
  9% { opacity: .15; transform: translateX(1px); }
  12% { opacity: .65; transform: none; }
  15%, 100% { opacity: 1; transform: none; }
}
@keyframes fuzz-a {
  0%, 3% { opacity: 0; } 5% { opacity: .9; } 6% { opacity: .25; } 7.5% { opacity: .9; }
  9% { opacity: .3; } 10.5% { opacity: .7; } 13% { opacity: .15; } 15%, 100% { opacity: 0; }
}
@keyframes fuzz-b {
  0%, 4% { opacity: 0; } 5.5% { opacity: .3; } 6.5% { opacity: .85; } 8% { opacity: .25; }
  9.5% { opacity: .8; } 11.5% { opacity: .3; } 14%, 100% { opacity: 0; }
}
.settle { animation: settle 10s linear infinite; }
.fuzz-a { animation: fuzz-a 10s steps(1, end) infinite; }
.fuzz-b { animation: fuzz-b 10s steps(1, end) infinite; }`;

function heroMark(theme, { x, y, cols, rows, size }) {
  const cellW = size * CHAR;
  const cellH = size * 1.22;
  const grid = rasterize({ cols, rows, aspect: cellH / cellW, echoes: 6 });
  const rand = random(7);
  const sparkle = new Set();
  const lit = [];
  grid.forEach((line, row) => line.forEach((cell, col) => cell.kind && lit.push([row, col])));
  while (sparkle.size < 48) {
    const [row, col] = lit[Math.floor(rand() * lit.length)];
    sparkle.add(`${row}:${col}`);
  }

  const bands = [0.38, 0.58, 0.8, 1];
  const band = (level) => bands.findIndex((cap, index) => 0.22 + level * 0.78 <= cap + 1e-9 || index === bands.length - 1);
  const parts = [];
  grid.forEach((line, row) => {
    const delay = 120 + row * 32;
    const layers = new Map();
    let noise = '';
    let fuzzA = '';
    let fuzzB = '';
    const pick = () => NOISE[Math.floor(rand() * NOISE.length)];
    line.forEach((cell, col) => {
      noise += cell.kind ? pick() : ' ';
      // The garble spills a cell past the silhouette so the edges go fuzzy too.
      const edge = !cell.kind && (line[col - 1]?.kind || line[col + 1]?.kind || grid[row - 1]?.[col]?.kind || grid[row + 1]?.[col]?.kind);
      fuzzA += cell.kind || (edge && rand() < 0.4) ? pick() : ' ';
      fuzzB += cell.kind || (edge && rand() < 0.4) ? pick() : ' ';
      for (const kind of ['fill', 'echo']) {
        for (let b = 0; b < bands.length; b++) {
          const key = `${kind}${b}`;
          if (!layers.has(key)) layers.set(key, []);
          const show = cell.kind === kind && band(cell.level) === b && !sparkle.has(`${row}:${col}`);
          layers.get(key).push(show ? glyph(cell.level, kind) : ' ');
        }
      }
    });
    const baseline = y + (row + 0.82) * cellH;
    if (noise.trim()) {
      parts.push(mono(noise.trimEnd(), x, baseline, size, `class="acc" opacity="0.45" style="animation: gone 380ms ease-in ${delay + 260}ms both"`));
    }
    const settled = [];
    for (const [key, chars] of layers) {
      const text = chars.join('').trimEnd();
      if (!text.trim()) continue;
      const kind = key.slice(0, 4);
      const opacity = bands[Number(key[4])];
      const fill = kind === 'fill' ? 'url(#shine)' : theme.echo;
      settled.push(
        mono(text, x, baseline, size, `fill="${fill}" opacity="${kind === 'echo' ? round(0.35 + opacity * 0.55) : opacity}" style="animation: fade 420ms ease-out ${delay + 300}ms both"`),
      );
    }
    if (!settled.length && !fuzzA.trim()) return;
    // Every cycle the row dissolves into noise and settles back, a little out of step
    // with its neighbours so the mark fuzzes rather than wipes.
    const garble = `animation-delay: ${Math.round(GARBLE_START + row * 5 + rand() * 380)}ms`;
    parts.push(`<g class="settle" style="${garble}">${settled.join('')}</g>`);
    parts.push(mono(fuzzA.trimEnd(), x, baseline, size, `fill="${theme.echo}" opacity="0" class="fuzz-a" style="${garble}"`));
    parts.push(mono(fuzzB.trimEnd(), x, baseline, size, `fill="${theme.ink}" opacity="0" class="fuzz-b" style="${garble}"`));
  });

  // A few cells keep glitching between their glyph and noise, like the app's shimmer.
  [...sparkle].forEach((key, index) => {
    const [row, col] = key.split(':').map(Number);
    const cell = grid[row][col];
    const cx = x + col * cellW;
    const cy = y + (row + 0.82) * cellH;
    const begin = round(2 + rand() * 7);
    const dur = round(5 + rand() * 4);
    const color = cell.kind === 'fill' ? theme.ink : theme.echo;
    const alpha = round(0.22 + cell.level * 0.78);
    parts.push(
      `<g class="settle" style="animation-delay: ${GARBLE_START + row * 5 + 190}ms"><g style="animation: fade 400ms ${1700 + row * 20}ms both"><text x="${round(cx)}" y="${round(cy)}" font-size="${size}" fill="${color}" opacity="${alpha}">${escape(glyph(cell.level, cell.kind))}<animate attributeName="opacity" values="${alpha};${alpha};0;${alpha}" keyTimes="0;0.9;0.93;1" dur="${dur}s" begin="${begin}s" repeatCount="indefinite"/></text>` +
        `<text x="${round(cx)}" y="${round(cy)}" font-size="${size}" class="acc" opacity="0">${escape(NOISE[index % NOISE.length])}<animate attributeName="opacity" values="0;0;1;0" keyTimes="0;0.9;0.93;1" dur="${dur}s" begin="${begin}s" repeatCount="indefinite"/></text></g></g>`,
    );
  });

  const height = rows * cellH;
  const width = cols * cellW;
  return {
    width,
    height,
    defs: `<linearGradient id="shine" gradientUnits="userSpaceOnUse" x1="${x - width}" y1="0" x2="${x}" y2="${height * 0.4}">
  <stop offset="0" stop-color="${theme.ink}"/><stop offset="0.42" stop-color="${theme.ink}"/>
  <stop offset="0.5" stop-color="${theme.accent}"/><stop offset="0.58" stop-color="${theme.ink}"/><stop offset="1" stop-color="${theme.ink}"/>
  <animateTransform attributeName="gradientTransform" type="translate" from="0 0" to="${round(width * 2.2)} 0" dur="7s" begin="2s" repeatCount="indefinite"/>
</linearGradient>`,
    body: `${parts.join('\n')}`,
  };
}

function hero(theme, data) {
  const width = 900;
  const height = 360;
  const days = data.user.contributionsCollection.contributionCalendar.weeks.flatMap((week) => week.contributionDays);
  const c = data.user.contributionsCollection;
  const mark = heroMark(theme, { x: 32, y: 30, cols: 94, rows: 44, size: 5.5 });

  // Terminal window on the right.
  const tx = 384;
  const ty = 28;
  const tw = width - tx - 26;
  const th = height - ty * 2;
  const size = 13;
  const lineH = 21;
  const left = tx + 22;
  let cursor = ty + 62;
  let clock = 0.5;
  const lines = [];
  const command = (text) => {
    const id = `c${lines.length}`;
    const chars = text.length + 2;
    const w = round(chars * size * CHAR);
    const dur = round(0.03 * chars + 0.12);
    lines.push(`<clipPath id="${id}"><rect x="${left}" y="${cursor - size}" width="0" height="${lineH}">
  <animate attributeName="width" from="0" to="${w + 4}" dur="${dur}s" begin="${clock}s" fill="freeze"/></rect></clipPath>
<g clip-path="url(#${id})">${mono('❯', left, cursor, size, 'class="acc"')}${mono(text, left + 2 * size * CHAR, cursor, size, 'class="ink" font-weight="600"')}</g>`);
    clock += dur + 0.18;
    cursor += lineH;
  };
  const output = (segments) => {
    let col = 2;
    const runs = segments.map(([text, cls]) => {
      const run = mono(text, left + col * size * CHAR, cursor, size, `class="${cls}"`);
      col += text.length;
      return run;
    });
    lines.push(`<g class="rise" style="animation-delay: ${round(clock * 1000)}ms">${runs.join('')}</g>`);
    clock += 0.09;
    cursor += lineH;
  };
  const gap = () => {
    cursor += 7;
    clock += 0.25;
  };

  command('whoami');
  output([['Caden Sumner', 'ink'], [' · software engineer · Denver, CO', 'sec']]);
  output([['Senior Engineer @ WeMod', 'sec'], [' · ', 'ter'], ['building Jackalope Digital', 'acc']]);
  gap();
  command('ls ~/building');
  output([['jackalope   ', 'acc'], ['desktop workspace for coding agents', 'sec']]);
  output([['allmcps     ', 'acc'], ['open directory of 22k+ MCP servers', 'sec']]);
  output([['moxie-docs  ', 'acc'], ['living docs for private GitHub repos', 'sec']]);
  gap();
  command('git stats --last 365d');
  output([
    [fmt(c.contributionCalendar.totalContributions), 'ink'],
    [' contributions · ', 'sec'],
    [fmt(c.totalCommitContributions), 'ink'],
    [' commits · ', 'sec'],
    [fmt(c.totalPullRequestContributions), 'ink'],
    [' PRs', 'sec'],
  ]);
  output([
    [fmt(c.totalRepositoriesWithContributedCommits), 'ink'],
    [' repos committed to', 'sec'],
    [` · on GitHub since ${data.user.createdAt.slice(0, 4)}`, 'ter'],
  ]);
  gap();
  const promptY = cursor;
  lines.push(`<g style="animation: fade 200ms ${round(clock * 1000)}ms both">${mono('❯', left, promptY, size, 'class="acc"')}
<rect x="${round(left + 2 * size * CHAR)}" y="${promptY - size + 2}" width="${round(size * CHAR)}" height="${size + 1}" fill="${theme.accent}">
  <animate attributeName="opacity" values="1;1;0;0" keyTimes="0;0.5;0.5;1" dur="1.1s" repeatCount="indefinite"/></rect></g>`);

  const body = `<defs>
<radialGradient id="glow" cx="0.2" cy="0.5" r="0.55"><stop offset="0" stop-color="${theme.glow}" stop-opacity="0.22"/><stop offset="1" stop-color="${theme.glow}" stop-opacity="0"/></radialGradient>
${mark.defs}
</defs>
<rect x="1" y="1" width="${width - 2}" height="${height - 2}" rx="13" fill="url(#glow)"/>
${mark.body}
<g class="rise" style="animation-delay: 150ms">
<rect x="${tx}" y="${ty}" width="${tw}" height="${th}" rx="10" fill="${theme.panel}" stroke="${theme.border}"/>
<circle cx="${tx + 18}" cy="${ty + 17}" r="4.5" fill="${theme.muted}"/><circle cx="${tx + 33}" cy="${ty + 17}" r="4.5" fill="${theme.muted}"/><circle cx="${tx + 48}" cy="${ty + 17}" r="4.5" fill="${theme.muted}"/>
${mono('caden@jackalope: ~', tx + tw / 2 - 18 * 11 * CHAR / 2, ty + 21, 11, 'class="ter"')}
<line x1="${tx}" y1="${ty + 34}" x2="${tx + tw}" y2="${ty + 34}" stroke="${theme.border}"/>
</g>
${lines.join('\n')}`;
  return svg(width, height, theme, body, GARBLE_STYLE);
}

// ── pulse ────────────────────────────────────────────────────────────────────

const LEVELS = {
  NONE: ['·', 'mut', 1],
  FIRST_QUARTILE: [':', 'acc', 0.45],
  SECOND_QUARTILE: ['+', 'acc', 0.65],
  THIRD_QUARTILE: ['#', 'acc', 0.85],
  FOURTH_QUARTILE: ['@', 'acc', 1],
};

function pulse(theme, data) {
  const width = 900;
  const height = 344;
  const calendar = data.user.contributionsCollection.contributionCalendar;
  const weeks = calendar.weeks;
  const days = weeks.flatMap((week) => week.contributionDays);
  const { longest, current } = streaks(days);
  const best = days.reduce((top, day) => (day.contributionCount > top.contributionCount ? day : top), days[0]);
  const byWeekday = Array(7).fill(0);
  for (const day of days) byWeekday[day.weekday] += day.contributionCount;
  const weekdayNames = ['Sundays', 'Mondays', 'Tuesdays', 'Wednesdays', 'Thursdays', 'Fridays', 'Saturdays'];
  const busiest = weekdayNames[byWeekday.indexOf(Math.max(...byWeekday))];

  const gx = 70;
  const gy = 78;
  const cw = (width - gx - 34) / weeks.length;
  const ch = 17;
  const size = 13;
  const parts = [];

  parts.push(mono('contribution pulse', 34, 44, 13, 'class="ink" font-weight="600"'));
  parts.push(mono('· last 12 months', 34 + 19 * 13 * CHAR, 44, 13, 'class="ter"'));
  const legend = Object.values(LEVELS);
  const legendX = width - 34 - (legend.length * 2 + 9) * 12 * CHAR;
  parts.push(mono('less', legendX, 44, 12, 'class="ter"'));
  legend.forEach(([char, cls, alpha], index) =>
    parts.push(mono(char, legendX + (5 + index * 2) * 12 * CHAR, 44, 12, `class="${cls}" opacity="${alpha}"`)),
  );
  parts.push(mono('more', legendX + (5 + legend.length * 2) * 12 * CHAR, 44, 12, 'class="ter"'));

  ['Mon', 'Wed', 'Fri'].forEach((label, index) =>
    parts.push(mono(label, 34, gy + (1 + index * 2) * ch + ch * 0.7, 11, 'class="ter"')),
  );
  let lastMonth = '';
  weeks.forEach((week, column) => {
    const first = week.contributionDays[0];
    const month = new Date(`${first.date}T00:00:00Z`).toLocaleString('en-US', { month: 'short', timeZone: 'UTC' });
    if (month !== lastMonth && column < weeks.length - 2) {
      if (lastMonth || Number(first.date.slice(8)) <= 7) {
        parts.push(mono(month.toLowerCase(), gx + column * cw, gy - 8, 11, 'class="ter"'));
      }
      lastMonth = month;
    }
    const cells = week.contributionDays.map((day) => {
      const [char, cls, alpha] = LEVELS[day.contributionLevel] ?? LEVELS.NONE;
      const isToday = day.date === days[days.length - 1].date;
      const cx = gx + column * cw + cw / 2;
      const cy = gy + day.weekday * ch + ch * 0.72;
      const blink = isToday
        ? `<animate attributeName="opacity" values="${alpha};0.15;${alpha}" dur="1.6s" repeatCount="indefinite"/>`
        : '';
      return `<text x="${round(cx)}" y="${round(cy)}" font-size="${size}" text-anchor="middle" class="${cls}" opacity="${alpha}">${escape(char)}${blink}</text>`;
    });
    parts.push(`<g class="rise" style="animation-delay: ${200 + column * 22}ms">${cells.join('')}</g>`);
  });

  // A slow light sweeping across the grid.
  const gridW = weeks.length * cw;
  parts.push(`<defs><linearGradient id="sweep" x1="0" x2="1"><stop offset="0" stop-color="${theme.accent}" stop-opacity="0"/><stop offset="0.5" stop-color="${theme.accent}" stop-opacity="0.09"/><stop offset="1" stop-color="${theme.accent}" stop-opacity="0"/></linearGradient></defs>
<rect x="${gx - 90}" y="${gy - 2}" width="90" height="${7 * ch + 4}" fill="url(#sweep)">
  <animate attributeName="x" from="${gx - 90}" to="${round(gx + gridW)}" dur="6s" begin="2s" repeatCount="indefinite"/></rect>`);

  // Stat row.
  const sy = gy + 7 * ch + 46;
  const bestDate = new Date(`${best.date}T00:00:00Z`)
    .toLocaleString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })
    .toLowerCase();
  const stats = [
    [fmt(calendar.totalContributions), 'contributions'],
    [`${current}d`, 'current streak'],
    [`${longest}d`, 'longest streak'],
    [fmt(best.contributionCount), `best day · ${bestDate}`],
    [busiest.toLowerCase(), 'busiest day'],
  ];
  const slot = (width - 68) / stats.length;
  stats.forEach(([value, label], index) => {
    const x = 34 + index * slot;
    parts.push(`<g class="rise" style="animation-delay: ${1300 + index * 90}ms">${mono(value, x, sy, 18, 'class="ink" font-weight="600"')}${mono(label, x, sy + 20, 11, 'class="ter"')}</g>`);
  });

  // Languages, as one segmented bar.
  const ly = sy + 48;
  const entries = Object.entries(data.languages).sort((a, b) => b[1].size - a[1].size);
  const total = entries.reduce((sum, [, lang]) => sum + lang.size, 0) || 1;
  const top = entries.slice(0, 6);
  const other = total - top.reduce((sum, [, lang]) => sum + lang.size, 0);
  if (other > 0) top.push(['Other', { size: other, color: theme.muted }]);
  const barW = width - 68;
  let bx = 34;
  const segments = [];
  const legendParts = [];
  let lx = 34;
  top.forEach(([name, lang], index) => {
    const share = lang.size / total;
    const w = Math.max(2, share * barW - 3);
    const color = LANG_COLORS[name] ?? lang.color ?? theme.muted;
    segments.push(`<rect x="${round(bx)}" y="${ly}" width="${round(w)}" height="8" rx="2" fill="${color}"/>`);
    bx += share * barW;
    const label = `${name} ${(share * 100).toFixed(share < 0.1 ? 1 : 0)}%`;
    legendParts.push(`<circle cx="${round(lx + 4)}" cy="${ly + 25}" r="4" fill="${color}"/>${mono(label, lx + 13, ly + 29, 11, 'class="sec"')}`);
    lx += 13 + label.length * 11 * CHAR + 18;
  });
  parts.push(`<g style="animation: fade 600ms 1700ms both">${segments.join('')}${legendParts.join('')}</g>`);
  const stamp = `refreshed ${data.generatedAt.slice(0, 10)}`;
  parts.push(mono(stamp, width - 34 - stamp.length * 10 * CHAR, ly + 29, 10, 'class="mut"'));

  return svg(width, height, theme, parts.join('\n'));
}

// ── project cards ────────────────────────────────────────────────────────────

const SPARK = '▁▂▃▄▅▆▇█';

function card(theme, item, repo, now) {
  const width = 440;
  const height = 168;
  const [owner, name] = item.repo.split('/');
  const parts = [];
  parts.push(mono(`${owner}/`, 24, 36, 12, 'class="ter"'));
  parts.push(mono(name, 24 + (owner.length + 1) * 12 * CHAR, 36, 12, 'class="ink" font-weight="700"'));
  const tagW = item.tag.length * 10 * CHAR + 16;
  parts.push(`<rect x="${round(width - 24 - tagW)}" y="22" width="${round(tagW)}" height="19" rx="9.5" fill="none" stroke="${theme.accent}" stroke-opacity="0.5"/>`);
  parts.push(mono(item.tag, width - 24 - tagW + 8, 35.5, 10, 'class="acc"'));
  item.blurb.forEach((line, index) =>
    parts.push(`<text x="24" y="${68 + index * 21}" font-size="14" class="sans sec">${escape(line)}</text>`),
  );

  // Footer: stack, activity, license and a 16-week commit sparkline.
  const fy = height - 26;
  const lang = repo.primaryLanguage;
  const x = 24;
  const footer = [];
  if (lang) {
    footer.push(`<circle cx="${x + 5}" cy="${fy - 4}" r="5" fill="${LANG_COLORS[lang.name] ?? lang.color}"/>`);
    footer.push(mono(item.stack, x + 16, fy, 11, 'class="sec"'));
  }
  parts.push(footer.join(''));
  const license = repo.licenseInfo?.spdxId && repo.licenseInfo.spdxId !== 'NOASSERTION' ? repo.licenseInfo.spdxId : null;
  const status = [ago(repo.pushedAt, now), license && `${license} license`].filter(Boolean).join(' · ');
  parts.push(mono(status, 24, fy - 26, 10, 'class="ter"'));

  const max = Math.max(1, ...repo.weekly);
  const spark = repo.weekly.map((count) => (count === 0 ? '▁' : SPARK[Math.min(7, 1 + Math.round((count / max) * 6))])).join('');
  const sx = width - 24 - spark.length * 12 * CHAR;
  parts.push(`<g style="animation: fade 500ms 400ms both">${mono(spark, sx, fy, 12, 'class="acc"')}</g>`);
  const commits = repo.weekly.reduce((sum, count) => sum + count, 0);
  const label = `${fmt(commits)} commits · 16w`;
  parts.push(mono(label, width - 24 - label.length * 10 * CHAR, fy - 26, 10, 'class="ter"'));

  return svg(width, height, theme, `<g class="rise">${parts.join('\n')}</g>`);
}

// ── main ─────────────────────────────────────────────────────────────────────

const fixtureIndex = process.argv.indexOf('--fixture');
const data =
  fixtureIndex > 0 ? JSON.parse(readFileSync(process.argv[fixtureIndex + 1], 'utf8')) : await fetchData();
if (process.argv.includes('--save')) {
  writeFileSync(process.argv[process.argv.indexOf('--save') + 1], JSON.stringify(data, null, 2));
}

mkdirSync(ASSETS, { recursive: true });
for (const [mode, theme] of Object.entries(THEMES)) {
  writeFileSync(join(ASSETS, `hero-${mode}.svg`), hero(theme, data));
  writeFileSync(join(ASSETS, `pulse-${mode}.svg`), pulse(theme, data));
  for (const item of FEATURED) {
    const repo = data.repos[item.repo];
    if (!repo) throw new Error(`Missing data for ${item.repo}`);
    const slug = item.repo.split('/')[1].toLowerCase();
    writeFileSync(join(ASSETS, `card-${slug}-${mode}.svg`), card(theme, item, repo, data.generatedAt));
  }
}
console.log(`Rendered ${Object.keys(THEMES).length * (2 + FEATURED.length)} graphics at ${data.generatedAt}`);
