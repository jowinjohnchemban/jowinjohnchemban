#!/usr/bin/env node
// Regenerates the profile cards in assets/ and the auto-updated sections of README.md.
// No dependencies: needs Node 18+ (built-in fetch) and a GitHub token in GH_TOKEN.
// Data comes only from the GitHub GraphQL API and the channel's own YouTube feed.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ASSETS = path.join(ROOT, 'assets');
const README = path.join(ROOT, 'README.md');

// ---------------------------------------------------------------- config --

export const CONFIG = {
  login: process.env.GH_LOGIN || 'jowinjohnchemban',
  name: 'Jowin John Chemban',
  location: 'Kerala, India',
  website: 'jowinjc.in',
  roles: [
    'Cloud Solutions · Systems · Network Engineering',
    'Security · Full-Stack Development',
    'DevOps · Platform Engineering · Automation · CI/CD',
    'Linux · Windows · AWS · Azure · GCP · Cloudflare',
  ],
  stack: [
    ['Cloud', ['AWS', 'Azure', 'Google Cloud', 'Cloudflare', 'Firebase']],
    ['Infrastructure', ['Linux', 'Windows', 'Networking', 'Security']],
    ['DevOps', ['Docker', 'Git', 'CI/CD', 'Bash', 'Selenium']],
    ['Development', ['C', 'C++', 'Python', 'JavaScript', 'TypeScript', 'HTML']],
    ['Data & AI', ['TensorFlow', 'OpenCV', 'MySQL', 'SQL Server', 'Chart.js', 'LLM prompting']],
    ['Design', ['Photoshop', 'Illustrator']],
  ],
  youtubeChannelId: 'UCWmOY9vHq624b_1FicorhDA',
  projectCount: 6,
  videoCount: 5,
  topLanguages: 8,
  timeZone: 'Asia/Kolkata',
};

const THEMES = {
  dark: {
    bg: '#0d1117', panel: '#161b22', border: '#30363d', text: '#e6edf3', muted: '#9198a1',
    accent: '#58a6ff', accent2: '#bc8cff',
    heat: ['#161b22', '#0d3a7a', '#1660d0', '#3f8cff', '#9ccaff'],
  },
  light: {
    bg: '#ffffff', panel: '#f6f8fa', border: '#d0d7de', text: '#1f2328', muted: '#59636e',
    accent: '#0969da', accent2: '#8250df',
    heat: ['#eff2f5', '#c5dcff', '#7fb0fb', '#2f7de8', '#0a4aa6'],
  },
};

const FONT = `'Segoe UI', -apple-system, BlinkMacSystemFont, 'Helvetica Neue', Arial, sans-serif`;
const MONO = `ui-monospace, SFMono-Regular, 'Cascadia Code', Consolas, Menlo, monospace`;

// ----------------------------------------------------------------- fetch --

async function graphql(query, variables = {}) {
  const token = process.env.GH_TOKEN;
  if (!token) throw new Error('GH_TOKEN is not set');
  const res = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: { authorization: `bearer ${token}`, 'content-type': 'application/json', 'user-agent': CONFIG.login },
    body: JSON.stringify({ query, variables }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.errors) {
    throw new Error(`GitHub GraphQL failed (${res.status}): ${JSON.stringify(body.errors || body)}`);
  }
  return body.data;
}

const CALENDAR = `contributionCalendar { totalContributions weeks { contributionDays { date contributionCount } } }`;

async function fetchGitHub(login) {
  const repos = [];
  let user;
  let after = null;
  do {
    const data = await graphql(
      `query($login: String!, $after: String) {
        user(login: $login) {
          name createdAt
          followers { totalCount }
          pullRequests { totalCount }
          issues { totalCount }
          contributionsCollection { ${CALENDAR} }
          repositories(first: 100, after: $after, ownerAffiliations: OWNER, privacy: PUBLIC,
                       orderBy: { field: PUSHED_AT, direction: DESC }) {
            pageInfo { hasNextPage endCursor }
            nodes {
              name description url isFork isArchived stargazerCount pushedAt
              primaryLanguage { name }
              languages(first: 10, orderBy: { field: SIZE, direction: DESC }) {
                edges { size node { name color } }
              }
            }
          }
        }
      }`,
      { login, after },
    );
    user ??= data.user;
    repos.push(...data.user.repositories.nodes);
    const page = data.user.repositories.pageInfo;
    after = page.hasNextPage ? page.endCursor : null;
  } while (after);

  // A contributions range may span at most one year, so ask for each year in one aliased query.
  const now = new Date();
  const created = new Date(user.createdAt);
  const ranges = [];
  for (let y = created.getUTCFullYear(); y <= now.getUTCFullYear(); y++) {
    const from = new Date(Math.max(created, Date.UTC(y, 0, 1)));
    const to = new Date(Math.min(now, Date.UTC(y, 11, 31, 23, 59, 59)));
    ranges.push(`y${y}: contributionsCollection(from: "${from.toISOString()}", to: "${to.toISOString()}") { ${CALENDAR} }`);
  }
  const years = await graphql(`query($login: String!) { user(login: $login) { ${ranges.join('\n')} } }`, { login });

  return { user, repos, years: Object.values(years.user) };
}

async function fetchVideos(channelId) {
  const res = await fetch(`https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`);
  if (!res.ok) throw new Error(`YouTube feed failed (${res.status})`);
  const xml = await res.text();
  return [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map(([, entry]) => ({
    title: decodeEntities(entry.match(/<title>([\s\S]*?)<\/title>/)?.[1] ?? ''),
    url: entry.match(/<link rel="alternate" href="([^"]+)"/)?.[1] ?? '',
    published: entry.match(/<published>([^<]+)<\/published>/)?.[1] ?? '',
  })).filter((v) => v.title && v.url);
}

// --------------------------------------------------------------- shaping --

const days = (collection) =>
  collection.contributionCalendar.weeks.flatMap((w) => w.contributionDays);

export function summarize({ user, repos, years }) {
  const owned = repos.filter((r) => !r.isFork);

  const daily = new Map();
  for (const year of years) for (const d of days(year)) daily.set(d.date, d.contributionCount);
  const dates = [...daily.keys()].sort();

  let longest = 0;
  let run = 0;
  for (const date of dates) {
    run = daily.get(date) > 0 ? run + 1 : 0;
    longest = Math.max(longest, run);
  }
  // Today still counts toward the streak while it has no contributions yet.
  let current = 0;
  let i = dates.length - 1;
  if (i >= 0 && daily.get(dates[i]) === 0) i--;
  for (; i >= 0 && daily.get(dates[i]) > 0; i--) current++;

  const bytes = new Map();
  const colors = new Map();
  for (const repo of owned) {
    for (const { size, node } of repo.languages.edges) {
      bytes.set(node.name, (bytes.get(node.name) ?? 0) + size);
      colors.set(node.name, node.color ?? '#8b949e');
    }
  }
  const total = [...bytes.values()].reduce((a, b) => a + b, 0) || 1;
  const ranked = [...bytes].sort((a, b) => b[1] - a[1]);
  // Languages under half a percent would only add 0.0% rows, so they join "Other".
  const shown = ranked.slice(0, CONFIG.topLanguages).filter(([, size]) => size / total >= 0.005);
  const languages = shown.map(([name, size]) => ({ name, color: colors.get(name), share: size / total }));
  const rest = ranked.slice(shown.length).reduce((sum, [, size]) => sum + size, 0);
  if (rest / total >= 0.0005) languages.push({ name: 'Other', color: '#6e7681', share: rest / total });

  const calendar = user.contributionsCollection.contributionCalendar;
  const lastYear = days(user.contributionsCollection);
  const best = lastYear.reduce((a, b) => (b.contributionCount > a.contributionCount ? b : a), lastYear[0]);

  return {
    since: new Date(user.createdAt).getUTCFullYear(),
    stats: [
      ['Total contributions', years.reduce((sum, y) => sum + y.contributionCalendar.totalContributions, 0)],
      ['Past year', calendar.totalContributions],
      ['Current streak', current, 'day'],
      ['Longest streak', longest, 'day'],
      ['Stars earned', owned.reduce((sum, r) => sum + r.stargazerCount, 0)],
      ['Original repos', owned.length],
      ['Pull requests', user.pullRequests.totalCount],
      ['Followers', user.followers.totalCount],
    ],
    languages,
    calendar: calendar.weeks,
    activeDays: lastYear.filter((d) => d.contributionCount > 0).length,
    best,
    projects: owned
      .filter((r) => !r.isArchived && r.name.toLowerCase() !== CONFIG.login.toLowerCase())
      .slice(0, CONFIG.projectCount),
  };
}

// ------------------------------------------------------------------- svg --

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function decodeEntities(s) {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

const compact = (n) =>
  n >= 10000 ? `${(n / 1000).toFixed(n >= 100000 ? 0 : 1).replace(/\.0$/, '')}k` : n.toLocaleString('en-US');

function svg(width, height, title, t, body, style = '') {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(title)}">
<title>${esc(title)}</title>
<style>
text { font-family: ${FONT}; fill: ${t.text}; }
.muted { fill: ${t.muted}; }
.h { font-size: 19px; font-weight: 600; }
${style}
@media (prefers-reduced-motion: reduce) { * { animation: none !important; } }
</style>
<rect x="0.5" y="0.5" width="${width - 1}" height="${height - 1}" rx="14" fill="${t.bg}" stroke="${t.border}"/>
${body}
</svg>
`;
}

export function headerCard(t) {
  const n = CONFIG.roles.length;
  const step = 3.2;
  const slot = 100 / n;
  const roles = CONFIG.roles
    .map((role, i) => `<text class="role r${i}" x="56" y="178" style="animation-delay:${(i * step).toFixed(1)}s">${esc(role)}</text>`)
    .join('\n');

  // A small pulsing network on the right, a nod to systems and networks.
  const nodes = [[800, 70], [880, 52], [940, 110], [860, 128], [790, 160], [900, 188], [960, 170]];
  const edges = [[0, 1], [1, 2], [0, 3], [1, 3], [2, 3], [3, 4], [3, 5], [2, 6], [5, 6], [4, 5]];
  const net = [
    ...edges.map(([a, b], i) => `<line class="edge" x1="${nodes[a][0]}" y1="${nodes[a][1]}" x2="${nodes[b][0]}" y2="${nodes[b][1]}" style="animation-delay:${(i * 0.35).toFixed(2)}s"/>`),
    ...nodes.map(([x, y], i) => `<circle class="node" cx="${x}" cy="${y}" r="${i === 3 ? 7 : 5}" style="animation-delay:${(i * 0.45).toFixed(2)}s"/>`),
  ].join('\n');

  const style = `
.hi { font-size: 22px; }
.name { font-size: 52px; font-weight: 700; letter-spacing: -0.5px; fill: url(#grad); }
.role { font-size: 24px; font-weight: 500; opacity: 0; animation: cycle ${(n * step).toFixed(1)}s ease-in-out infinite both; }
.r0 { opacity: 1; }
.prompt { font-family: ${MONO}; font-size: 22px; fill: ${t.accent}; }
.meta { font-size: 15px; }
.edge { stroke: ${t.border}; stroke-width: 1.5; animation: glow 3.5s ease-in-out infinite both; }
.node { fill: ${t.accent}; animation: pulse 3.2s ease-in-out infinite both; }
@keyframes cycle {
  0% { opacity: 0; transform: translateY(10px); }
  ${(slot * 0.12).toFixed(2)}% { opacity: 1; transform: translateY(0); }
  ${(slot * 0.85).toFixed(2)}% { opacity: 1; transform: translateY(0); }
  ${slot.toFixed(2)}% { opacity: 0; transform: translateY(-10px); }
  100% { opacity: 0; }
}
@keyframes pulse { 0%, 100% { opacity: 0.35; } 50% { opacity: 1; } }
@keyframes glow { 0%, 100% { stroke: ${t.border}; } 50% { stroke: ${t.accent}; } }
@media (prefers-reduced-motion: reduce) { .role { opacity: 0; } .r0 { opacity: 1; } }`;

  const body = `<defs><linearGradient id="grad" x1="0" x2="1"><stop offset="0" stop-color="${t.accent}"/><stop offset="1" stop-color="${t.accent2}"/></linearGradient></defs>
<text class="hi muted" x="48" y="70">Hi there, I'm</text>
<text class="name" x="46" y="126">${esc(CONFIG.name)}</text>
<text class="prompt" x="30" y="178">›</text>
${roles}
<text class="meta muted" x="48" y="222">${esc(CONFIG.location)}  ·  ${esc(CONFIG.website)}</text>
${net}`;
  return svg(1000, 250, `${CONFIG.name}: ${CONFIG.roles.join(', ')}`, t, body, style);
}

export function stackCard(t) {
  const pill = (label) => 22 + label.length * 8.2;
  const x0 = 180;
  const maxX = 968;
  let y = 76;
  const rows = [];
  for (const [group, items] of CONFIG.stack) {
    let x = x0;
    const pills = [];
    for (const item of items) {
      const w = pill(item);
      if (x + w > maxX) { x = x0; y += 44; }
      pills.push(`<g transform="translate(${x.toFixed(1)},${y - 21})"><rect width="${w.toFixed(1)}" height="32" rx="16" fill="${t.panel}" stroke="${t.border}"/><text class="pill" x="${(w / 2).toFixed(1)}" y="21">${esc(item)}</text></g>`);
      x += w + 10;
    }
    rows.push(`<text class="group muted" x="32" y="${y}">${esc(group)}</text>\n${pills.join('\n')}`);
    y += 50;
  }
  const height = y - 4;
  const style = `.group { font-size: 15px; font-weight: 600; } .pill { font-size: 14px; text-anchor: middle; }`;
  const body = `<text class="h" x="32" y="40">Tech stack</text>\n${rows.join('\n')}`;
  const alt = CONFIG.stack.map(([g, items]) => `${g}: ${items.join(', ')}`).join('; ');
  return svg(1000, height, `Tech stack. ${alt}`, t, body, style);
}

export function overviewCard(t, s) {
  const cells = s.stats.map(([label, value, unit], i) => {
    const x = 32 + (i % 2) * 240;
    const y = 104 + Math.floor(i / 2) * 58;
    const suffix = unit ? ` ${unit}${value === 1 ? '' : 's'}` : '';
    return `<text class="label muted" x="${x}" y="${y - 24}">${esc(label)}</text><text class="value" x="${x}" y="${y + 4}">${compact(value)}<tspan class="unit muted">${esc(suffix)}</tspan></text>`;
  });

  const bx = 556;
  const bw = 412;
  let off = 0;
  const segments = s.languages.map((lang) => {
    const w = Math.max(lang.share * bw, 0);
    const seg = `<rect x="${(bx + off).toFixed(2)}" y="74" width="${w.toFixed(2)}" height="12" fill="${lang.color}"/>`;
    off += w;
    return seg;
  });
  const legend = s.languages.map((lang, i) => {
    const x = bx + (i % 2) * 210;
    const y = 122 + Math.floor(i / 2) * 34;
    const pct = lang.share >= 0.1 ? (lang.share * 100).toFixed(0) : (lang.share * 100).toFixed(1);
    return `<circle cx="${x + 6}" cy="${y - 5}" r="6" fill="${lang.color}"/><text class="lang" x="${x + 20}" y="${y}">${esc(lang.name)} <tspan class="muted">${pct}%</tspan></text>`;
  });

  const height = 104 + 3 * 58 + 66;
  const style = `
.label { font-size: 13px; letter-spacing: 0.3px; }
.value { font-size: 26px; font-weight: 700; font-variant-numeric: tabular-nums; }
.unit { font-size: 15px; font-weight: 400; }
.lang { font-size: 14px; }
.sub { font-size: 13px; }`;
  const body = `<text class="h" x="32" y="42">GitHub at a glance</text>
<text class="sub muted" x="32" y="${height - 22}">On GitHub since ${s.since} · public activity</text>
${cells.join('\n')}
<line x1="524" y1="32" x2="524" y2="${height - 32}" stroke="${t.border}"/>
<text class="h" x="${bx}" y="42">Top languages</text>
<clipPath id="bar"><rect x="${bx}" y="74" width="${bw}" height="12" rx="6"/></clipPath>
<rect x="${bx}" y="74" width="${bw}" height="12" rx="6" fill="${t.panel}"/>
<g clip-path="url(#bar)">${segments.join('')}</g>
${legend.join('\n')}`;
  const alt = s.stats.map(([l, v]) => `${l}: ${v}`).join(', ');
  const langs = s.languages.map((l) => `${l.name} ${(l.share * 100).toFixed(1)}%`).join(', ');
  return svg(1000, height, `GitHub stats. ${alt}. Top languages: ${langs}`, t, body, style);
}

export function contributionsCard(t, s) {
  const weeks = s.calendar;
  const all = weeks.flatMap((w) => w.contributionDays);
  const max = Math.max(1, ...all.map((d) => d.contributionCount));
  const level = (c) => (c === 0 ? 0 : Math.min(4, Math.ceil((c / max) * 4)));
  const cell = 14;
  const gap = 3;
  const stepPx = cell + gap;
  const gridW = weeks.length * stepPx - gap;
  const x0 = 968 - gridW;
  const y0 = 86;

  const rects = [];
  const months = [];
  let lastMonth = -1;
  weeks.forEach((week, wi) => {
    const x = x0 + wi * stepPx;
    for (const day of week.contributionDays) {
      const wd = new Date(`${day.date}T00:00:00Z`).getUTCDay();
      const title = `${day.contributionCount} contribution${day.contributionCount === 1 ? '' : 's'} on ${day.date}`;
      rects.push(`<rect x="${x}" y="${y0 + wd * stepPx}" width="${cell}" height="${cell}" rx="3" fill="${t.heat[level(day.contributionCount)]}"><title>${title}</title></rect>`);
    }
    const first = week.contributionDays[0];
    const month = new Date(`${first.date}T00:00:00Z`).getUTCMonth();
    if (month !== lastMonth && wi < weeks.length - 2) {
      if (lastMonth !== -1 || new Date(`${first.date}T00:00:00Z`).getUTCDate() <= 7) {
        months.push(`<text class="axis muted" x="${x}" y="${y0 - 10}">${MONTHS[month]}</text>`);
      }
      lastMonth = month;
    }
  });
  const weekdays = [[1, 'Mon'], [3, 'Wed'], [5, 'Fri']]
    .map(([d, l]) => `<text class="axis muted" x="${x0 - 10}" y="${y0 + d * stepPx + 11}" text-anchor="end">${l}</text>`);

  const yb = y0 + 7 * stepPx + 30;
  const legendX = 968 - 36 - 5 * stepPx;
  const legend = t.heat.map((c, i) => `<rect x="${legendX + i * stepPx}" y="${yb - 12}" width="${cell}" height="${cell}" rx="3" fill="${c}"/>`);
  const total = s.stats[1][1];
  const bestText = s.best && s.best.contributionCount > 0
    ? ` · best day ${s.best.contributionCount} on ${formatDate(s.best.date, { day: 'numeric', month: 'short' })}`
    : '';

  const height = yb + 26;
  const style = `
.axis { font-size: 12px; }
.sum { font-size: 14px; }
.scan { animation: scan 6s ease-in-out infinite; }
@keyframes scan { 0% { transform: translateX(0); opacity: 0; } 15%, 85% { opacity: 1; } 100% { transform: translateX(${gridW}px); opacity: 0; } }`;
  const body = `<text class="h" x="32" y="42">Contributions in the last year</text>
<text class="sum muted" x="968" y="42" text-anchor="end">${total.toLocaleString('en-US')} contributions · ${s.activeDays} active days</text>
${months.join('\n')}
${weekdays.join('\n')}
${rects.join('\n')}
<defs><linearGradient id="beam" x1="0" x2="1"><stop offset="0" stop-color="${t.accent}" stop-opacity="0"/><stop offset="0.5" stop-color="${t.accent}" stop-opacity="0.22"/><stop offset="1" stop-color="${t.accent}" stop-opacity="0"/></linearGradient></defs>
<rect class="scan" x="${x0 - 40}" y="${y0 - 4}" width="80" height="${7 * stepPx + 5}" fill="url(#beam)" opacity="0" pointer-events="none"/>
<text class="sum muted" x="${x0}" y="${yb}">Current streak ${s.stats[2][1]} · longest ${s.stats[3][1]} days${esc(bestText)}</text>
<text class="axis muted" x="${legendX - 8}" y="${yb}" text-anchor="end">Less</text>
${legend.join('')}
<text class="axis muted" x="${legendX + 5 * stepPx + 4}" y="${yb}">More</text>`;
  return svg(1000, height, `${total} contributions in the last year, ${s.activeDays} active days`, t, body, style);
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function formatDate(iso, opts = { day: 'numeric', month: 'short', year: 'numeric' }) {
  return new Intl.DateTimeFormat('en-GB', { ...opts, timeZone: CONFIG.timeZone }).format(new Date(iso));
}

// -------------------------------------------------------------- markdown --

const md = (s) => String(s).replace(/[\\`*_[\]|<>]/g, (c) => (c === '<' ? '&lt;' : c === '>' ? '&gt;' : `\\${c}`));

const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

export function projectsSection(projects) {
  return projects.map((r) => {
    const lang = r.primaryLanguage ? ` · ${md(r.primaryLanguage.name)}` : '';
    const stars = r.stargazerCount ? ` · ★ ${r.stargazerCount}` : '';
    const about = r.description ? ` — ${md(clip(r.description.trim(), 140))}` : '';
    return `- **[${md(r.name)}](${r.url})**${lang}${stars}${about}`;
  }).join('\n');
}

export function videosSection(videos) {
  return videos.slice(0, CONFIG.videoCount)
    .map((v) => `- [${md(v.title)}](${v.url}) · ${formatDate(v.published, { month: 'short', year: 'numeric' })}`)
    .join('\n');
}

export function replaceSection(readme, name, content) {
  const re = new RegExp(`(<!-- START:${name} -->)[\\s\\S]*?(<!-- END:${name} -->)`);
  if (!re.test(readme)) throw new Error(`README is missing the ${name} markers`);
  return readme.replace(re, `$1\n${content}\n$2`);
}

// ------------------------------------------------------------------ main --

export async function writeAll(summary, videos) {
  await mkdir(ASSETS, { recursive: true });
  for (const [mode, t] of Object.entries(THEMES)) {
    await writeFile(path.join(ASSETS, `header-${mode}.svg`), headerCard(t));
    await writeFile(path.join(ASSETS, `stack-${mode}.svg`), stackCard(t));
    await writeFile(path.join(ASSETS, `overview-${mode}.svg`), overviewCard(t, summary));
    await writeFile(path.join(ASSETS, `contributions-${mode}.svg`), contributionsCard(t, summary));
  }

  let readme = await readFile(README, 'utf8');
  readme = replaceSection(readme, 'projects', projectsSection(summary.projects));
  if (videos) readme = replaceSection(readme, 'videos', videosSection(videos));
  readme = replaceSection(readme, 'updated', `<sub>Cards and lists refresh automatically · last updated ${formatDate(new Date().toISOString())}</sub>`);
  await writeFile(README, readme);
}

async function main() {
  const summary = summarize(await fetchGitHub(CONFIG.login));
  // The video list is a nice-to-have: keep the previous list if the feed is unavailable.
  const videos = await fetchVideos(CONFIG.youtubeChannelId).catch((err) => {
    console.warn(`Skipping videos: ${err.message}`);
    return null;
  });
  await writeAll(summary, videos);
  console.log(`Updated ${summary.projects.length} projects, ${videos?.length ?? 0} videos, ${summary.languages.length} languages.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
