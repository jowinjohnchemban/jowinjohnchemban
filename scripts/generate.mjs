#!/usr/bin/env node
// Builds the profile: SVG cards in assets/ and README.md, from config.js plus live GitHub data.
// No dependencies: needs Node 18+ (built-in fetch) and a GitHub token in GH_TOKEN.
// Private repos appear only if the token can see them, and then only by name and language.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import config from '../config.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ASSETS = path.join(ROOT, 'assets');
const README = path.join(ROOT, 'README.md');

const FONT = `'Segoe UI', -apple-system, BlinkMacSystemFont, 'Helvetica Neue', Arial, sans-serif`;
const MONO = `ui-monospace, SFMono-Regular, 'Cascadia Code', Consolas, Menlo, monospace`;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// ----------------------------------------------------------------- fetch --

async function graphql(query, variables = {}) {
  const token = process.env.GH_TOKEN;
  if (!token) throw new Error('GH_TOKEN is not set');
  const res = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: { authorization: `bearer ${token}`, 'content-type': 'application/json', 'user-agent': config.login },
    body: JSON.stringify({ query, variables }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.errors) {
    throw new Error(`GitHub GraphQL failed (${res.status}): ${JSON.stringify(body.errors || body)}`);
  }
  return body.data;
}

// Pages through one connection on the user, returning every node.
async function collect(login, field, nodeFields, args = '') {
  const nodes = [];
  let after = null;
  do {
    const data = await graphql(
      `query($login: String!, $after: String) {
        user(login: $login) {
          ${field}(first: 100, after: $after${args}) { pageInfo { hasNextPage endCursor } nodes { ${nodeFields} } }
        }
      }`,
      { login, after },
    );
    const conn = data.user[field];
    nodes.push(...conn.nodes);
    after = conn.pageInfo.hasNextPage ? conn.pageInfo.endCursor : null;
  } while (after);
  return nodes;
}

const CALENDAR = `contributionCalendar { totalContributions weeks { contributionDays { date contributionCount } } }`;
const TYPES = `totalCommitContributions totalPullRequestContributions totalIssueContributions
  totalPullRequestReviewContributions totalRepositoryContributions restrictedContributionsCount`;
const REPO = `repository { nameWithOwner url isPrivate owner { login } }`;
const NEWEST = ', orderBy: { field: CREATED_AT, direction: DESC }';

async function fetchProfile(login) {
  const { user } = await graphql(
    `query($login: String!) {
      user(login: $login) {
        createdAt
        followers { totalCount }
        pullRequests { totalCount }
        contributionsCollection { ${TYPES} ${CALENDAR} }
      }
    }`,
    { login },
  );
  const repos = await collect(login, 'repositories', `
    name description url createdAt isFork isArchived isPrivate stargazerCount
    primaryLanguage { name }
    languages(first: 10, orderBy: { field: SIZE, direction: DESC }) { edges { size node { name } } }
    repositoryTopics(first: 20) { nodes { topic { name } } }`,
  ', ownerAffiliations: OWNER, orderBy: { field: PUSHED_AT, direction: DESC }');

  // A contributions range may span at most one year, so ask for each year in one aliased query.
  const now = new Date();
  const created = new Date(user.createdAt);
  const ranges = [];
  for (let y = created.getUTCFullYear(); y <= now.getUTCFullYear(); y++) {
    const from = new Date(Math.max(created, Date.UTC(y, 0, 1)));
    const to = new Date(Math.min(now, Date.UTC(y, 11, 31, 23, 59, 59)));
    ranges.push(`y${y}: contributionsCollection(from: "${from.toISOString()}", to: "${to.toISOString()}") { ${CALENDAR} }`);
  }
  const data = await graphql(`query($login: String!) { user(login: $login) { ${ranges.join('\n')} } }`, { login });
  const years = Object.entries(data.user).map(([key, c]) => ({ year: Number(key.slice(1)), ...c }));

  return { user, repos, years };
}

async function fetchOpenSource(login) {
  // Discussions are a bonus: if the token cannot read them, the rest still renders.
  const optional = (p, what) => p.catch((err) => {
    console.warn(`Skipping ${what}: ${err.message}`);
    return null;
  });
  const [pullRequests, issues, discussions, comments] = await Promise.all([
    collect(login, 'pullRequests', `title url state createdAt ${REPO}`, NEWEST),
    collect(login, 'issues', `title url state createdAt ${REPO}`, NEWEST),
    optional(collect(login, 'repositoryDiscussions', `title url createdAt ${REPO}`, NEWEST), 'discussions'),
    optional(collect(login, 'repositoryDiscussionComments', `url createdAt discussion { title url ${REPO} }`), 'discussion comments'),
  ]);
  return {
    pullRequests,
    issues,
    discussions,
    comments: comments && comments.filter((c) => c.discussion).map((c) => ({ ...c, ...c.discussion, url: c.url })),
  };
}

// --------------------------------------------------------------- shaping --

const days = (collection) => collection.contributionCalendar.weeks.flatMap((w) => w.contributionDays);
const sum = (values) => values.reduce((a, b) => a + b, 0);
const excluded = new Set(config.languages.exclude);

export function summarize({ user, repos, years }) {
  const owned = repos.filter((r) => !r.isFork);
  // Stars, repo count and the language breakdown describe public work only.
  const publicOwned = owned.filter((r) => !r.isPrivate);
  const since = new Date(user.createdAt).getUTCFullYear();

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

  // One language order for every card, so a language keeps its color everywhere.
  const bytes = new Map();
  for (const repo of publicOwned) {
    for (const { size, node } of repo.languages.edges) {
      if (!excluded.has(node.name)) bytes.set(node.name, (bytes.get(node.name) ?? 0) + size);
    }
  }
  const ranked = [...bytes].sort((a, b) => b[1] - a[1]);
  const total = sum([...bytes.values()]) || 1;
  const journey = learningJourney(owned, repos, since);
  // Public languages first by size, then languages that only show up in the journey.
  const order = [...new Set([...ranked.map(([name]) => name), ...journey.byWeight])];
  const slotOf = new Map(order.slice(0, THEME_SLOTS).map((name, slot) => [name, slot]));
  const cumulative = (perYear) => {
    let run = 0;
    return perYear.map((v) => (run += v));
  };
  journey.curve = [
    { name: 'Languages', values: cumulative(journey.added.map((a) => a.languages.length)) },
    { name: 'Topics', values: cumulative(journey.added.map((a) => a.topics.length)) },
  ];
  journey.perLanguage = [...slotOf].filter(([name]) => journey.byWeight.includes(name)).map(([name, slot]) => ({
    name, slot, values: cumulative(journey.years.map((y) => journey.counts.get(y).get(name) ?? 0)),
  }));

  const named = ranked.filter(([name, size]) => slotOf.has(name) && size / total >= 0.005).map(([name]) => name);
  const languages = named.map((name) => ({ name, slot: slotOf.get(name), share: bytes.get(name) / total }));
  const rest = sum(ranked.filter(([name]) => !named.includes(name)).map(([, size]) => size));
  if (rest / total >= 0.0005) languages.push({ name: 'Other', slot: -1, share: rest / total });

  const collection = user.contributionsCollection;
  const lastYear = days(collection);
  const best = lastYear.reduce((a, b) => (b.contributionCount > a.contributionCount ? b : a), lastYear[0]);

  const weekdays = [0, 0, 0, 0, 0, 0, 0];
  for (const d of lastYear) weekdays[new Date(`${d.date}T00:00:00Z`).getUTCDay()] += d.contributionCount;

  const types = [
    ['Commits', collection.totalCommitContributions],
    ['Pull requests', collection.totalPullRequestContributions],
    ['Issues', collection.totalIssueContributions],
    ['Code reviews', collection.totalPullRequestReviewContributions],
    ['New repos', collection.totalRepositoryContributions],
  ];
  if (collection.restrictedContributionsCount > 0) types.push(['Private work', collection.restrictedContributionsCount]);

  return {
    since,
    stats: [
      ['Total contributions', sum(years.map((y) => y.contributionCalendar.totalContributions))],
      ['Past year', collection.contributionCalendar.totalContributions],
      ['Current streak', current, 'day'],
      ['Longest streak', longest, 'day'],
      ['Stars earned', sum(publicOwned.map((r) => r.stargazerCount))],
      ['Public repos', publicOwned.length],
      ['Pull requests', user.pullRequests.totalCount],
      ['Followers', user.followers.totalCount],
    ],
    languages,
    calendar: collection.contributionCalendar.weeks,
    activeDays: lastYear.filter((d) => d.contributionCount > 0).length,
    best,
    byYear: years.map((y) => ({ label: String(y.year), value: y.contributionCalendar.totalContributions })),
    types: types.map(([label, value]) => ({ label, value })),
    byWeek: collection.contributionCalendar.weeks.map((week, i, all) => {
      const start = week.contributionDays[0].date;
      const month = Number(start.slice(5, 7)) - 1;
      const newMonth = i > 0 && month !== Number(all[i - 1].contributionDays[0].date.slice(5, 7)) - 1;
      return { label: newMonth ? MONTHS[month] : '', value: sum(week.contributionDays.map((d) => d.contributionCount)), title: `Week of ${start}` };
    }),
    byWeekday: [1, 2, 3, 4, 5, 6, 0].map((d) => ({ label: WEEKDAYS[d], value: weekdays[d] })),
    journey,
    projects: owned
      .filter((r) => !r.isArchived && r.name.toLowerCase() !== config.login.toLowerCase())
      .filter((r) => config.projects.includePrivate || !r.isPrivate)
      .slice(0, config.projects.count),
  };
}

// How the language mix and topics change over time, by the year each repo was created.
function learningJourney(owned, repos, since) {
  const yearOf = (r) => new Date(r.createdAt).getUTCFullYear();
  const years = [];
  for (let y = since; y <= new Date().getUTCFullYear(); y++) years.push(y);

  // counts: year -> language -> number of projects started that year that use it.
  const counts = new Map(years.map((y) => [y, new Map()]));
  const firstLanguage = new Map();
  const weight = new Map();
  for (const repo of owned) {
    const size = sum(repo.languages.edges.map((e) => e.size));
    const y = yearOf(repo);
    if (!size || !counts.has(y)) continue;
    for (const { size: part, node } of repo.languages.edges) {
      // Ignore incidental languages (a build script, a stray stylesheet).
      if (part / size < 0.05 || excluded.has(node.name)) continue;
      counts.get(y).set(node.name, (counts.get(y).get(node.name) ?? 0) + 1);
      weight.set(node.name, (weight.get(node.name) ?? 0) + part);
      if (!firstLanguage.has(node.name) || y < firstLanguage.get(node.name)) firstLanguage.set(node.name, y);
    }
  }

  // Topics come from public repos, forks included: forking something is part of exploring it.
  const firstTopic = new Map();
  for (const repo of repos) {
    if (repo.isPrivate) continue;
    for (const { topic } of repo.repositoryTopics.nodes) {
      const y = yearOf(repo);
      if (!firstTopic.has(topic.name) || y < firstTopic.get(topic.name)) firstTopic.set(topic.name, y);
    }
  }

  const added = years.map((year) => ({
    year,
    languages: [...firstLanguage].filter(([, y]) => y === year).map(([n]) => n).sort((a, b) => weight.get(b) - weight.get(a)),
    topics: [...firstTopic].filter(([, y]) => y === year).map(([n]) => n).sort(),
  }));
  return {
    years,
    counts,
    added,
    byWeight: [...weight].sort((a, b) => b[1] - a[1]).map(([n]) => n),
    languageCount: firstLanguage.size,
    topicCount: firstTopic.size,
  };
}

export function summarizeOpenSource(os, login) {
  const external = (x) => x.repository && !x.repository.isPrivate && x.repository.owner.login.toLowerCase() !== login.toLowerCase();
  const prs = os.pullRequests.filter(external);
  const issues = os.issues.filter(external);
  const discussions = os.discussions?.filter(external) ?? null;
  const comments = os.comments?.filter(external) ?? null;

  const repos = new Map();
  const bump = (item, kind) => {
    const key = item.repository.nameWithOwner;
    const r = repos.get(key) ?? { name: key, url: item.repository.url, pr: 0, issue: 0, discussion: 0 };
    r[kind]++;
    repos.set(key, r);
  };
  prs.forEach((x) => bump(x, 'pr'));
  issues.forEach((x) => bump(x, 'issue'));
  discussions?.forEach((x) => bump(x, 'discussion'));
  comments?.forEach((x) => bump(x, 'discussion'));

  const merged = prs.filter((p) => p.state === 'MERGED').length;
  const decided = prs.filter((p) => p.state !== 'OPEN').length;
  const posts = discussions && comments ? discussions.length + comments.length : null;

  return {
    kpis: [
      ['Pull requests', num(prs.length)],
      ['Merged', num(merged)],
      ['Merge rate', decided ? `${Math.round((merged / decided) * 100)}%` : '–'],
      ['Issues opened', num(issues.length)],
      ['Discussion posts', posts === null ? '–' : num(posts)],
      ['Repositories', num(repos.size)],
    ],
    top: [...repos.values()]
      .map((r) => ({ ...r, total: r.pr + r.issue + r.discussion }))
      .sort((a, b) => b.total - a.total || a.name.localeCompare(b.name))
      .slice(0, config.openSource.topRepos),
    recent: [
      ...prs.map((x) => ({ ...x, kind: 'pr' })),
      ...issues.map((x) => ({ ...x, kind: 'issue' })),
      ...(discussions ?? []).map((x) => ({ ...x, kind: 'discussion' })),
    ].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, config.openSource.recent),
  };
}

// ------------------------------------------------------------ svg basics --

const THEME_SLOTS = Math.min(...Object.values(config.themes).map((t) => t.series.length));
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const num = (n) => n.toLocaleString('en-US');
const compact = (n) =>
  n >= 10000 ? `${(n / 1000).toFixed(n >= 100000 ? 0 : 1).replace(/\.0$/, '')}k` : num(n);
const f = (n) => +n.toFixed(1);
const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);
const colorOf = (t, slot) => (slot === -1 ? t.other : t.series[slot]);

function svg(width, height, title, t, body, style = '') {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(title)}">
<title>${esc(title)}</title>
<style>
text { font-family: ${FONT}; fill: ${t.text}; }
.muted { fill: ${t.muted}; }
.h { font-size: 19px; font-weight: 600; }
.k { font-size: 13px; font-weight: 600; letter-spacing: 0.2px; }
.axis { font-size: 12px; }
.val { font-size: 12px; font-weight: 600; }
.row { font-size: 14px; }
${style}
@media (prefers-reduced-motion: reduce) { * { animation: none !important; } }
</style>
<rect x="0.5" y="0.5" width="${width - 1}" height="${height - 1}" rx="14" fill="${t.bg}" stroke="${t.border}"/>
${body}
</svg>
`;
}

// Bars are anchored to the baseline with a 4px rounded data end.
function rightRounded(x, y, w, h, r = 4) {
  r = Math.min(r, w, h / 2);
  return `M${f(x)},${f(y)}H${f(x + w - r)}Q${f(x + w)},${f(y)} ${f(x + w)},${f(y + r)}V${f(y + h - r)}Q${f(x + w)},${f(y + h)} ${f(x + w - r)},${f(y + h)}H${f(x)}Z`;
}

function niceMax(v) {
  const p = 10 ** Math.floor(Math.log10(Math.max(v, 1)));
  return [1, 2, 2.5, 5, 10].map((m) => m * p).find((m) => m >= v);
}

// Line chart on one y-axis. A single series gets a soft area; several get labels at their ends.
// `labels` are the x-axis ticks (empty strings are skipped); `marks` picks which points show values.
function lineChart(series, labels, { x, y, w, h }, t, { marks = 'ends', tips = labels } = {}) {
  const max = niceMax(Math.max(1, ...series.flatMap((s) => s.values)));
  const n = labels.length;
  const px = (i) => x + (n === 1 ? w / 2 : (i / (n - 1)) * w);
  const py = (v) => y + h - (v / max) * h;
  const out = [];
  for (const k of [0, 0.5, 1]) {
    const gy = f(py(max * k));
    out.push(`<line x1="${x}" y1="${gy}" x2="${x + w}" y2="${gy}" stroke="${k === 0 ? t.border : t.panel}"/>`);
    out.push(`<text class="axis muted" x="${x - 10}" y="${gy + 4}" text-anchor="end">${compact(max * k)}</text>`);
  }
  labels.forEach((label, i) => {
    if (label) out.push(`<text class="axis muted" x="${f(px(i))}" y="${y + h + 20}" text-anchor="middle">${esc(label)}</text>`);
  });

  const single = series.length === 1;
  for (const s of series) {
    const pts = s.values.map((v, i) => [f(px(i)), f(py(v))]);
    const d = pts.map(([a, b], i) => `${i ? 'L' : 'M'}${a},${b}`).join('');
    if (single) out.push(`<path d="${d}L${pts.at(-1)[0]},${y + h}L${pts[0][0]},${y + h}Z" fill="${s.color}" opacity="0.15"/>`);
    out.push(`<path class="line" d="${d}" fill="none" stroke="${s.color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`);

    // Which points get a dot and a value: the peak and the latest, or every point.
    const peak = s.values.indexOf(Math.max(...s.values));
    const shown = marks === 'all' ? s.values.map((_, i) => i) : single ? [...new Set([peak, n - 1])] : [n - 1];
    for (const i of shown) {
      out.push(`<circle cx="${pts[i][0]}" cy="${pts[i][1]}" r="4" fill="${s.color}" stroke="${t.bg}" stroke-width="2"/>`);
      if (single) out.push(`<text class="val" x="${pts[i][0]}" y="${f(pts[i][1] - 10)}" text-anchor="middle">${compact(s.values[i])}</text>`);
    }
    pts.forEach(([a, b], i) => out.push(`<circle cx="${a}" cy="${b}" r="9" fill="transparent"><title>${esc(`${s.name ? `${s.name} · ` : ''}${tips[i] || labels[i]}: ${num(s.values[i])}`)}</title></circle>`));
  }

  // Several series: name each line at its end, nudged apart so labels never collide.
  if (!single) {
    const ends = series.map((s) => ({ s, y: py(s.values.at(-1)) })).sort((a, b) => a.y - b.y);
    for (let i = 1; i < ends.length; i++) ends[i].y = Math.max(ends[i].y, ends[i - 1].y + 15);
    for (const { s, y: ly } of ends) {
      out.push(`<line x1="${x + w + 10}" y1="${f(ly)}" x2="${x + w + 20}" y2="${f(ly)}" stroke="${s.color}" stroke-width="3" stroke-linecap="round"/>`);
      out.push(`<text class="axis" x="${x + w + 26}" y="${f(ly + 4)}">${esc(s.name)} <tspan class="muted">${num(s.values.at(-1))}</tspan></text>`);
    }
  }
  return out.join('\n');
}

function hbars(items, { x, y, labelW, barW, rowH }, t) {
  const max = Math.max(1, ...items.map((d) => d.value));
  return items.map((d, i) => {
    const cy = y + i * rowH;
    const bw = (d.value / max) * barW;
    const bar = bw > 0 ? `<path d="${rightRounded(x + labelW, cy - 6, bw, 12)}" fill="${t.accent}"/>` : '';
    return `<text class="row" x="${x}" y="${cy + 5}">${esc(d.label)}</text>${bar}<text class="val" x="${f(x + labelW + bw + 8)}" y="${cy + 5}">${esc(d.display ?? compact(d.value))}</text>`;
  }).join('\n');
}

// ----------------------------------------------------------------- cards --

export function headerCard(t) {
  const n = config.roles.length;
  const step = 3.2;
  const slot = 100 / n;
  const roles = config.roles
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

  const meta = [config.location, config.website].filter(Boolean).map(esc).join('  ·  ');
  const body = `<defs><linearGradient id="grad" x1="0" x2="1"><stop offset="0" stop-color="${t.accent}"/><stop offset="1" stop-color="${t.accent2}"/></linearGradient></defs>
<text class="hi muted" x="48" y="70">${esc(config.greeting)}</text>
<text class="name" x="46" y="126">${esc(config.name)}</text>
<text class="prompt" x="30" y="178">›</text>
${roles}
<text class="meta muted" x="48" y="222">${meta}</text>
${net}`;
  return svg(1000, 250, `${config.name}: ${config.roles.join(', ')}`, t, body, style);
}

export function stackCard(t) {
  const pill = (label) => 22 + label.length * 8.2;
  const x0 = 180;
  let y = 76;
  const rows = [];
  for (const [group, items] of config.stack) {
    let x = x0;
    const pills = [];
    for (const item of items) {
      const w = pill(item);
      if (x + w > 968) { x = x0; y += 44; }
      pills.push(`<g transform="translate(${f(x)},${y - 21})"><rect width="${f(w)}" height="32" rx="16" fill="${t.panel}" stroke="${t.border}"/><text class="pill" x="${f(w / 2)}" y="21">${esc(item)}</text></g>`);
      x += w + 10;
    }
    rows.push(`<text class="group muted" x="32" y="${y}">${esc(group)}</text>\n${pills.join('\n')}`);
    y += 50;
  }
  const style = `.group { font-size: 15px; font-weight: 600; } .pill { font-size: 14px; text-anchor: middle; }`;
  const body = `<text class="h" x="32" y="40">Tech stack</text>\n${rows.join('\n')}`;
  const alt = config.stack.map(([g, items]) => `${g}: ${items.join(', ')}`).join('; ');
  return svg(1000, y - 4, `Tech stack. ${alt}`, t, body, style);
}

export function overviewCard(t, s) {
  const cells = s.stats.map(([label, value, unit], i) => {
    const x = 32 + (i % 2) * 240;
    const y = 104 + Math.floor(i / 2) * 58;
    const suffix = unit ? ` ${unit}${value === 1 ? '' : 's'}` : '';
    return `<text class="label muted" x="${x}" y="${y - 24}">${esc(label)}</text><text class="value" x="${x}" y="${y + 4}">${compact(value)}<tspan class="unit muted">${esc(suffix)}</tspan></text>`;
  });

  // Stacked share bar with a 2px surface gap between segments.
  const bx = 556;
  const bw = 412;
  let off = 0;
  const segments = s.languages.map((lang) => {
    const w = lang.share * bw;
    const seg = `<rect x="${f(bx + off)}" y="74" width="${f(Math.max(w - 2, 0.5))}" height="12" fill="${colorOf(t, lang.slot)}"><title>${esc(lang.name)} ${pct(lang.share)}</title></rect>`;
    off += w;
    return seg;
  });
  const legend = s.languages.map((lang, i) => {
    const x = bx + (i % 2) * 210;
    const y = 122 + Math.floor(i / 2) * 34;
    return `<circle cx="${x + 6}" cy="${y - 5}" r="6" fill="${colorOf(t, lang.slot)}"/><text class="lang" x="${x + 20}" y="${y}">${esc(lang.name)} <tspan class="muted">${pct(lang.share)}</tspan></text>`;
  });

  const height = 104 + 3 * 58 + 66;
  const style = `
.label { font-size: 13px; letter-spacing: 0.3px; }
.value { font-size: 26px; font-weight: 700; }
.unit { font-size: 15px; font-weight: 400; }
.lang { font-size: 14px; }
.sub { font-size: 13px; }`;
  const body = `<text class="h" x="32" y="42">GitHub at a glance</text>
<text class="sub muted" x="32" y="${height - 22}">On GitHub since ${s.since}</text>
${cells.join('\n')}
<line x1="524" y1="32" x2="524" y2="${height - 32}" stroke="${t.border}"/>
<text class="h" x="${bx}" y="42">Top languages</text>
<clipPath id="bar"><rect x="${bx}" y="74" width="${bw}" height="12" rx="6"/></clipPath>
<g clip-path="url(#bar)">${segments.join('')}</g>
${legend.join('\n')}`;
  const alt = s.stats.map(([l, v]) => `${l}: ${v}`).join(', ');
  const langs = s.languages.map((l) => `${l.name} ${pct(l.share)}`).join(', ');
  return svg(1000, height, `GitHub stats. ${alt}. Top languages in public repos: ${langs}`, t, body, style);
}

const pct = (share) => `${(share * 100).toFixed(share >= 0.1 ? 0 : 1)}%`;

export function contributionsCard(t, s) {
  const weeks = s.calendar;
  const max = Math.max(1, ...weeks.flatMap((w) => w.contributionDays.map((d) => d.contributionCount)));
  const level = (c) => (c === 0 ? 0 : Math.min(4, Math.ceil((c / max) * 4)));
  const cell = 14;
  const stepPx = cell + 3;
  const gridW = weeks.length * stepPx - 3;
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
    const first = new Date(`${week.contributionDays[0].date}T00:00:00Z`);
    if (first.getUTCMonth() !== lastMonth && wi < weeks.length - 2) {
      if (lastMonth !== -1 || first.getUTCDate() <= 7) {
        months.push(`<text class="axis muted" x="${x}" y="${y0 - 10}">${MONTHS[first.getUTCMonth()]}</text>`);
      }
      lastMonth = first.getUTCMonth();
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

  const style = `
.sum { font-size: 14px; }
.scan { animation: scan 6s ease-in-out infinite; }
@keyframes scan { 0% { transform: translateX(0); opacity: 0; } 15%, 85% { opacity: 1; } 100% { transform: translateX(${gridW}px); opacity: 0; } }`;
  const body = `<text class="h" x="32" y="42">Contributions in the last year</text>
<text class="sum muted" x="968" y="42" text-anchor="end">${num(total)} contributions · ${s.activeDays} active days</text>
${months.join('\n')}
${weekdays.join('\n')}
${rects.join('\n')}
<defs><linearGradient id="beam" x1="0" x2="1"><stop offset="0" stop-color="${t.accent}" stop-opacity="0"/><stop offset="0.5" stop-color="${t.accent}" stop-opacity="0.22"/><stop offset="1" stop-color="${t.accent}" stop-opacity="0"/></linearGradient></defs>
<rect class="scan" x="${x0 - 40}" y="${y0 - 4}" width="80" height="${7 * stepPx + 5}" fill="url(#beam)" opacity="0" pointer-events="none"/>
<text class="sum muted" x="${x0}" y="${yb}">Current streak ${s.stats[2][1]} · longest ${s.stats[3][1]} days${esc(bestText)}</text>
<text class="axis muted" x="${legendX - 8}" y="${yb}" text-anchor="end">Less</text>
${legend.join('')}
<text class="axis muted" x="${legendX + 5 * stepPx + 4}" y="${yb}">More</text>`;
  return svg(1000, yb + 26, `${total} contributions in the last year, ${s.activeDays} active days`, t, body, style);
}

// A card with two titled panels; each panel is a function that draws into its box.
function splitCard(t, title, left, right, alt) {
  const body = `<text class="h" x="32" y="42">${esc(title)}</text>
<text class="k muted" x="32" y="80">${esc(left.title)}</text>
${left.draw({ x: 70, y: 110, w: 410, h: 150 })}
<line x1="530" y1="66" x2="530" y2="288" stroke="${t.border}"/>
<text class="k muted" x="562" y="80">${esc(right.title)}</text>
${right.draw({ x: 600, y: 110, w: 340, h: 150 })}`;
  return svg(1000, 310, `${title}. ${alt}`, t, body);
}

const series1 = (t, items) => [{ name: '', color: t.accent, values: items.map((d) => d.value) }];
const describe = (items) => items.map((d) => `${d.label || d.title} ${d.value}`).join(', ');

export const trendCard = (t, s) => splitCard(t, 'Contribution trend',
  { title: 'Contributions by year', draw: (box) => lineChart(series1(t, s.byYear), s.byYear.map((d) => d.label), box, t) },
  { title: 'Past year, by type', draw: ({ x, y }) => hbars(s.types, { x: x - 38, y: y - 6, labelW: 116, barW: 200, rowH: s.types.length > 5 ? 26 : 32 }, t) },
  `By year: ${describe(s.byYear)}. Past year by type: ${describe(s.types)}`);

export const rhythmCard = (t, s) => splitCard(t, 'Rhythm',
  { title: 'Weekly contributions, past year', draw: (box) => lineChart(series1(t, s.byWeek), s.byWeek.map((d) => d.label), box, t, { tips: s.byWeek.map((d) => d.title) }) },
  { title: 'Shape of the week, past year', draw: (box) => lineChart(series1(t, s.byWeekday), s.byWeekday.map((d) => d.label), box, t, { marks: 'all' }) },
  `Weekly contributions over the past year, peak ${Math.max(...s.byWeek.map((d) => d.value))}. By weekday: ${describe(s.byWeekday)}`);

export function journeyCard(t, s) {
  const j = s.journey;
  const x = 32;
  const w = 936;
  const band = w / j.years.length;
  const years = j.years.map(String);
  // Label every other year, counting back from the latest so it is always shown.
  const ticks = years.map((y, i) => ((years.length - 1 - i) % 2 === 0 ? y : ''));
  const curve = lineChart(
    j.curve.map((c, i) => ({ ...c, color: i ? t.accent2 : t.accent })),
    ticks,
    { x: 70, y: 110, w: 330, h: 140 }, t, { tips: years },
  );
  const perLanguage = j.perLanguage.length
    ? lineChart(
      j.perLanguage.map((l) => ({ ...l, color: colorOf(t, l.slot) })),
      ticks,
      { x: 568, y: 110, w: 290, h: 140 }, t, { tips: years },
    )
    : '';

  // What was new each year: languages first, then topics.
  const ty = 350;
  const perYear = 6;
  const lists = j.added.map((a, i) => {
    const cx = x + band * i + band / 2;
    const items = [...a.languages.map((n) => ({ n, lang: true })), ...a.topics.map((n) => ({ n: `#${n}`, lang: false }))];
    const count = items.length;
    const lines = items.slice(0, count > perYear ? perYear - 1 : perYear).map((it, k) =>
      `<text class="${it.lang ? 'new' : 'axis muted'}" x="${f(cx)}" y="${ty + 42 + k * 17}" text-anchor="middle">${esc(clip(it.n, Math.floor(band / 7)))}</text>`);
    if (count > perYear) lines.push(`<text class="axis muted" x="${f(cx)}" y="${ty + 42 + (perYear - 1) * 17}" text-anchor="middle">+${count - perYear + 1} more</text>`);
    const head = count ? `<text class="val" x="${f(cx)}" y="${ty + 22}" text-anchor="middle">+${count}</text>` : `<text class="axis muted" x="${f(cx)}" y="${ty + 22}" text-anchor="middle">–</text>`;
    return `<circle cx="${f(cx)}" cy="${ty}" r="4" fill="${count ? t.accent : t.border}"/>${head}${lines.join('')}`;
  });
  const height = ty + 42 + perYear * 17 + 12;

  const style = `.new { font-size: 12px; font-weight: 600; }`;
  const body = `<text class="h" x="32" y="42">Learning journey</text>
<text class="row muted" x="968" y="42" text-anchor="end">${j.languageCount} languages · ${j.topicCount} topics since ${s.since}</text>
<text class="k muted" x="32" y="80">Learning curve: languages and topics so far</text>
${curve}
<line x1="500" y1="66" x2="500" y2="282" stroke="${t.border}"/>
<text class="k muted" x="532" y="80">Projects per language, cumulative</text>
${perLanguage}
<text class="k muted" x="32" y="${ty - 22}">Picked up each year: new languages, then new #topics</text>
<line x1="${x}" y1="${ty}" x2="${x + w}" y2="${ty}" stroke="${t.border}"/>
${lists.join('\n')}`;
  const alt = j.added.filter((a) => a.languages.length || a.topics.length)
    .map((a) => `${a.year}: ${[...a.languages, ...a.topics.map((n) => `#${n}`)].join(', ')}`).join('; ');
  return svg(1000, height, `Learning journey: ${j.languageCount} languages and ${j.topicCount} topics. ${alt}`, t, body, style);
}

export function openSourceCard(t, o) {
  const tiles = o.kpis.map(([label, value], i) => {
    const x = 32 + i * 156;
    return `<text class="label muted" x="${x}" y="84">${esc(label)}</text><text class="value" x="${x}" y="116">${esc(value)}</text>`;
  });
  const rows = o.top.length
    ? hbars(o.top.map((r) => ({
      label: clip(r.name, 34),
      value: r.total,
      display: [[r.pr, 'PR'], [r.issue, 'issue'], [r.discussion, 'discussion']]
        .filter(([n]) => n).map(([n, w]) => `${n} ${w}${n === 1 ? '' : 's'}`).join(' · '),
    })), { x: 32, y: 202, labelW: 300, barW: 400, rowH: 32 }, t)
    : `<text class="row muted" x="32" y="207">No public contributions to other repositories yet.</text>`;
  const height = 202 + Math.max(o.top.length, 1) * 32 + 8;
  const style = `.label { font-size: 13px; letter-spacing: 0.3px; } .value { font-size: 26px; font-weight: 700; }`;
  const body = `<text class="h" x="32" y="42">Open-source contributions</text>
<text class="row muted" x="968" y="42" text-anchor="end">to repositories I don't own</text>
${tiles.join('\n')}
<line x1="32" y1="140" x2="968" y2="140" stroke="${t.border}"/>
<text class="k muted" x="32" y="172">Where I contribute most</text>
${rows}`;
  const alt = `${o.kpis.map(([l, v]) => `${l}: ${v}`).join(', ')}. Top repositories: ${o.top.map((r) => `${r.name} (${r.total})`).join(', ')}`;
  return svg(1000, height, `Open-source contributions. ${alt}`, t, body, style);
}

function formatDate(iso, opts = { day: 'numeric', month: 'short', year: 'numeric' }) {
  return new Intl.DateTimeFormat(config.locale, { ...opts, timeZone: config.timeZone }).format(new Date(iso));
}

// ---------------------------------------------------------------- readme --

const md = (s) => String(s).replace(/[\\`*_[\]|<>]/g, (c) => (c === '<' ? '&lt;' : c === '>' ? '&gt;' : `\\${c}`));

export function projectsList(projects) {
  return projects.map((r) => {
    const lang = r.primaryLanguage ? ` · ${md(r.primaryLanguage.name)}` : '';
    // A private repo shows its name only: no link, and no description that could leak details.
    if (r.isPrivate) return `- 🔒 **${md(r.name)}**${lang} · private`;
    const stars = r.stargazerCount ? ` · ★ ${r.stargazerCount}` : '';
    const about = r.description ? ` — ${md(clip(r.description.trim(), 140))}` : '';
    return `- **[${md(r.name)}](${r.url})**${lang}${stars}${about}`;
  }).join('\n');
}

const STATUS = {
  pr: { MERGED: '🟣 Merged PR', OPEN: '🟢 Open PR', CLOSED: '⚪ Closed PR' },
  issue: { OPEN: '🟢 Open issue', CLOSED: '⚪ Closed issue' },
};

export function openSourceList(o) {
  return o.recent.map((x) => {
    const status = x.kind === 'discussion' ? '💬 Discussion' : STATUS[x.kind][x.state] ?? x.state;
    const when = formatDate(x.createdAt, { month: 'short', year: 'numeric' });
    return `- ${status} · [${md(clip(x.title, 90))}](${x.url}) in [${md(x.repository.nameWithOwner)}](${x.repository.url}) · ${when}`;
  }).join('\n');
}

export function buildReadme(s, o) {
  const repo = process.env.GITHUB_REPOSITORY || `${config.login}/${config.login}`;
  const branch = process.env.GITHUB_REF_NAME || 'main';
  const picture = (file, alt) => {
    const src = (mode) => `https://raw.githubusercontent.com/${repo}/${branch}/assets/${file}-${mode}.svg`;
    return `<picture>
  <source media="(prefers-color-scheme: dark)" srcset="${src('dark')}">
  <img alt="${esc(alt)}" src="${src('light')}" width="100%">
</picture>`;
  };
  const on = config.sections;
  const out = [`<!-- Generated by scripts/generate.mjs from config.js. Edit config.js, not this file. -->`];

  out.push(picture('header', `${config.name}: ${config.roles.join(', ')}`));
  if (config.links.length) {
    const links = config.links.map((l) => `  <a href="${esc(l.url)}">${l.bold ? `<b>${esc(l.label)}</b>` : esc(l.label)}</a>`);
    out.push(`<p align="center">\n${links.join(' ·\n')}\n</p>`);
  }
  if (on.about) {
    out.push('## About me', ...config.about,
      config.highlights.map(([icon, label, text]) => `- ${icon} **${label}:** ${text}`).join('\n'));
  }
  if (on.stack) out.push('## Tech stack', picture('stack', `Tech stack. ${config.stack.map(([g, i]) => `${g}: ${i.join(', ')}`).join('. ')}`));

  const dashboard = [
    on.overview && picture('overview', 'GitHub stats and top languages'),
    on.heatmap && picture('contributions', 'Contribution calendar for the last year'),
    on.trend && picture('trend', 'Line chart of contributions by year, and past-year contributions by type'),
    on.rhythm && picture('rhythm', 'Line charts of weekly contributions over the past year and contributions by weekday'),
    on.journey && picture('journey', 'Learning journey: cumulative languages and topics, projects per language over time, and what was picked up each year'),
  ].filter(Boolean);
  if (dashboard.length) out.push('## Dashboard', ...dashboard);

  if (on.openSource && o) {
    out.push('## Open source', picture('opensource', 'Open-source contributions and the repositories I contribute to most'));
    if (o.recent.length) out.push('**Recent activity**', openSourceList(o));
  }
  if (on.projects && s.projects.length) out.push('## Recently active projects', projectsList(s.projects));
  out.push(footer(repo, new Date()));
  return `${out.join('\n\n')}\n`;
}

function footer(repo, when) {
  const stamp = formatDate(when.toISOString(), {
    day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
  });
  return `<p align="center"><sub>
⚡ Refreshed every 6 hours by <a href="https://github.com/${repo}/actions/workflows/refresh-profile.yml">GitHub Actions</a> · data last changed <!-- stamp -->${stamp}<!-- /stamp --> · <a href="https://github.com/${repo}/fork">Fork it</a> to make your own
</sub></p>`;
}

// The timestamp alone is not a change worth a commit.
const withoutStamp = (readme) => readme.replace(/<!-- stamp -->[\s\S]*?<!-- \/stamp -->/, '');

// ------------------------------------------------------------------ main --

export async function writeAll(s, o) {
  await mkdir(ASSETS, { recursive: true });
  const cards = {
    header: (t) => headerCard(t),
    stack: (t) => stackCard(t),
    overview: (t) => overviewCard(t, s),
    contributions: (t) => contributionsCard(t, s),
    trend: (t) => trendCard(t, s),
    rhythm: (t) => rhythmCard(t, s),
    journey: (t) => journeyCard(t, s),
    ...(o && { opensource: (t) => openSourceCard(t, o) }),
  };
  let changed = false;
  const write = async (file, content) => {
    if ((await readFile(file, 'utf8').catch(() => null)) === content) return;
    await writeFile(file, content);
    changed = true;
  };
  for (const [mode, t] of Object.entries(config.themes)) {
    for (const [name, render] of Object.entries(cards)) {
      await write(path.join(ASSETS, `${name}-${mode}.svg`), render(t));
    }
  }
  // Rewrite the README (and so its timestamp) only when the cards or its content really changed.
  const readme = buildReadme(s, o);
  const current = await readFile(README, 'utf8').catch(() => '');
  if (changed || withoutStamp(current) !== withoutStamp(readme)) await writeFile(README, readme);
}

async function main() {
  const [profile, openSource] = await Promise.all([
    fetchProfile(config.login),
    config.sections.openSource ? fetchOpenSource(config.login) : null,
  ]);
  const s = summarize(profile);
  const o = openSource && summarizeOpenSource(openSource, config.login);
  await writeAll(s, o);
  console.log(`Built the profile: ${s.projects.length} projects, ${s.languages.length} languages, ${o?.recent.length ?? 0} open-source items.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
