import * as fs from 'fs/promises';
import * as path from 'path';
import { FileCoverage, FileCoverageRow, Report } from './types';
import { countsRate, groupByFolder, headline, hotspots, pctText, rowRate, sumCounts, tierOf } from './reportData';
import { writeReportPdf } from './reportPdf';

const esc = (text: string): string =>
  text.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);

const anchor = (rel: string): string => `f-${rel.replace(/[^A-Za-z0-9]/g, '_')}`;

const STYLE = `
body{margin:0;font:13px/1.45 "Segoe UI",Arial,sans-serif;color:#1f2937;background:#f3f4f6}
header{background:#4338ca;color:#fff;padding:18px 28px}
header h1{margin:0;font-size:22px}
header p{margin:4px 0 0;opacity:.85}
main{padding:20px 28px;max-width:1280px;margin:auto}
.cards{display:grid;grid-template-columns:1.1fr 1.4fr 1fr 1fr;gap:14px;margin-bottom:16px}
.card{background:#fff;border:1px solid #e5e7eb;border-radius:8px;padding:14px 16px}
.card h3{margin:0 0 8px;font-size:13px;color:#6b7280;text-transform:uppercase;letter-spacing:.04em}
.card dl{display:grid;grid-template-columns:auto 1fr;gap:3px 10px;margin:0}
.card dt{color:#6b7280}
.card dd{margin:0;font-weight:600}
.big{font-size:44px;font-weight:700;line-height:1}
.na{color:#9ca3af}
.bar{height:10px;background:#e5e7eb;border-radius:5px;overflow:hidden;margin:10px 0 4px}
.bar span{display:block;height:100%}
.high{color:#15803d}.mid{color:#b45309}.low{color:#b91c1c}.none{color:#9ca3af}
.fill-high{background:#22c55e}.fill-mid{background:#f59e0b}.fill-low{background:#ef4444}.fill-none{background:#d1d5db}
.muted{color:#6b7280;font-size:12px}
section.panel{background:#fff;border:1px solid #e5e7eb;border-radius:8px;padding:14px 16px;margin-bottom:16px}
section.panel h2{margin:0 0 10px;font-size:16px}
table{width:100%;border-collapse:collapse;font-size:12px}
th,td{padding:5px 8px;text-align:left;border-bottom:1px solid #f1f5f9;vertical-align:middle}
th{background:#eef2ff;color:#374151;font-weight:600}
td.n,th.n{text-align:right;font-variant-numeric:tabular-nums}
tr.group td{background:#f8fafc;font-weight:700}
td.name a{color:#4338ca;text-decoration:none}
td.name a:hover{text-decoration:underline}
td.pctcell{min-width:200px}
.mini{display:flex;align-items:center;gap:8px}
.mini .bar{flex:1;margin:0;height:8px}
.src{margin:18px 0 0}
.src h3{margin:0 0 4px;font-size:14px;font-family:Consolas,monospace}
pre.code{margin:0;font:12px/1.4 Consolas,"Courier New",monospace;border:1px solid #e5e7eb;border-radius:6px;overflow:auto;background:#fff}
pre.code div{display:flex;white-space:pre}
pre.code .ln{width:56px;flex:none;text-align:right;padding:0 10px 0 6px;color:#9ca3af;background:#f9fafb;user-select:none}
pre.code .tx{padding:0 10px;flex:1}
pre.code .cov{background:#dcfce7}
pre.code .unc{background:#fee2e2}
footer{text-align:center;color:#9ca3af;font-size:12px;padding:12px 0 24px}
`;

function fileRow(row: FileCoverageRow, linked: Set<string>): string {
  const pct = rowRate(row);
  const tier = tierOf(pct);
  const after = row.after;
  const name = linked.has(row.path) ? `<a href="#${anchor(row.path)}">${esc(row.path)}</a>` : esc(row.path);
  const covered = after.total === undefined ? '—' : String(after.covered);
  const uncovered = after.total === undefined ? '—' : String(after.total - after.covered);
  const coverable = after.total === undefined ? '—' : String(after.total);
  return `<tr>
<td class="name">${name}</td>
<td class="n">${covered}</td>
<td class="n">${uncovered}</td>
<td class="n">${coverable}</td>
<td class="n">${row.before?.total === undefined ? 'n/a' : pctText(row.before.total === 0 ? 100 : (row.before.covered / row.before.total) * 100)}</td>
<td class="pctcell"><div class="mini"><div class="bar"><span class="fill-${tier}" style="width:${pct ?? 0}%"></span></div><span class="${tier}">${pctText(pct)}</span></div></td>
</tr>`;
}

function coverageTable(r: Report, linked: Set<string>): string {
  const groups = groupByFolder(r.fileCoverage);
  if (groups.length === 0) return '<p class="muted">No source files were measured.</p>';
  const body = groups
    .map(g => {
      const sums = sumCounts(g.rows);
      const pct = sums.total === 0 ? 100 : (sums.covered / sums.total) * 100;
      const tier = tierOf(sums.total === 0 ? undefined : pct);
      const head = `<tr class="group"><td class="name">${esc(g.folder)}</td><td class="n">${sums.covered}</td><td class="n">${sums.total - sums.covered}</td><td class="n">${sums.total}</td><td class="n"></td><td class="pctcell"><div class="mini"><div class="bar"><span class="fill-${tier}" style="width:${pct}%"></span></div><span class="${tier}">${pctText(pct)}</span></div></td></tr>`;
      return head + g.rows.map(row => fileRow(row, linked)).join('\n');
    })
    .join('\n');
  return `<table>
<thead><tr><th>Name</th><th class="n">Covered</th><th class="n">Uncovered</th><th class="n">Coverable</th><th class="n">Before</th><th>Coverage</th></tr></thead>
<tbody>${body}</tbody>
</table>`;
}

function hotspotTable(r: Report): string {
  const rows = hotspots(r.fileCoverage);
  if (rows.length === 0) return '<p class="muted">No files with uncovered code.</p>';
  return `<table><thead><tr><th>File</th><th class="n">Coverage</th><th>Uncovered lines</th></tr></thead><tbody>${rows
    .map(row => {
      const pct = rowRate(row);
      return `<tr><td class="name">${esc(row.path)}</td><td class="n ${tierOf(pct)}">${pctText(pct)}</td><td>${esc(row.missing || '—')}</td></tr>`;
    })
    .join('')}</tbody></table>`;
}

function sourcePage(file: FileCoverage, lines: string[]): string {
  const covered = new Set(file.covered);
  const uncovered = new Set(file.uncovered);
  const rows = lines
    .map((text, i) => {
      const n = i + 1;
      const cls = uncovered.has(n) ? 'unc' : covered.has(n) ? 'cov' : '';
      return `<div class="${cls}"><span class="ln">${n}</span><span class="tx">${esc(text) || ' '}</span></div>`;
    })
    .join('');
  const pct = file.executable === 0 ? 100 : (file.covered.length / file.executable) * 100;
  return `<div class="src" id="${anchor(file.rel)}">
<h3>${esc(file.rel)} <span class="muted">· ${file.covered.length}/${file.executable} lines covered (${pctText(pct)})</span></h3>
<pre class="code">${rows}</pre>
</div>`;
}

// Writes the HTML and PDF reports, replacing any earlier files at those paths.
export async function writeReportFiles(r: Report, repoPath: string, htmlFile: string, pdfFile: string): Promise<void> {
  const sources = new Map<string, string[]>();
  for (const f of r.coverageFiles) {
    try {
      sources.set(f.rel, (await fs.readFile(path.join(repoPath, f.rel), 'utf8')).split('\n'));
    } catch {
      // The file was removed or moved after the run; its source page is left out.
    }
  }
  await fs.writeFile(htmlFile, renderHtml(r, sources), 'utf8');
  await writeReportPdf(r, sources, pdfFile);
}

// Builds the single-file HTML report. `sources` maps each file in report.coverageFiles to its lines.
export function renderHtml(r: Report, sources: Map<string, string[]>): string {
  const head = headline(r);
  const tier = tierOf(head.pct);
  // A branch or method card: the value when the language measures it, otherwise n/a.
  const metricCard = (after: { covered: number; total: number } | undefined, before: { covered: number; total: number } | undefined): string => {
    const pct = countsRate(after);
    if (pct === undefined || !after) return '<div class="big na">n/a</div><div class="muted">Not measured for this language yet.</div>';
    const metricTier = tierOf(pct);
    const beforePct = countsRate(before);
    return `<div class="big ${metricTier}">${pctText(pct)}</div>
    <div class="bar"><span class="fill-${metricTier}" style="width:${pct}%"></span></div>
    <div class="muted">${after.covered} covered of ${after.total}</div>${beforePct === undefined ? '' : `<div class="muted">Before: ${pctText(beforePct)}</div>`}`;
  };
  const linked = new Set(r.coverageFiles.map(f => f.rel));
  const sourceParts = r.coverageFiles
    .filter(f => sources.has(f.rel))
    .map(f => sourcePage(f, sources.get(f.rel) ?? []))
    .join('\n');
  const projects = r.projects.map(p => `<div>${esc(p)}</div>`).join('');
  const testCases = r.testCases.length
    ? r.testCases
        .map(f => `<h3 class="muted" style="margin:10px 0 4px;color:#4338ca;font-family:Consolas,monospace">${esc(f.path)}</h3><ol>${f.names.map(n => `<li>${esc(n)}</li>`).join('') || '<li class="muted">No test case names detected.</li>'}</ol>`)
        .join('')
    : '<p class="muted">No test files were written in this run.</p>';
  const skipped = r.files.filter(f => f.status === 'skipped');
  const skippedHtml = skipped.length
    ? `<ul>${skipped.map(f => `<li><b>${esc(f.path)}</b>${f.note ? ` — <span class="muted">${esc(f.note)}</span>` : ''}</li>`).join('')}</ul>`
    : '<p class="muted">No files were skipped.</p>';

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Unit Test Report</title><style>${STYLE}</style></head>
<body>
<header><h1>Unit Test Report</h1><p>Test Automation Agent · generated ${esc(r.generatedAt)}</p></header>
<main>
<section class="cards">
  <div class="card"><h3>Information</h3><dl>
    <dt>Branch</dt><dd>${esc(r.branch)}</dd>
    <dt>Files measured</dt><dd>${r.fileCoverage.length}</dd>
    <dt>Tests written</dt><dd>${r.filesWritten}</dd>
    <dt>Skipped</dt><dd>${r.filesSkipped}</dd>
  </dl></div>
  <div class="card"><h3>${esc(head.label)}</h3>
    <div class="big ${tier}">${pctText(head.pct)}</div>
    <div class="bar"><span class="fill-${tier}" style="width:${head.pct}%"></span></div>
    <div class="muted">${head.covered} covered of ${head.total}${r.coverageAfter.unit === 'functions' ? ' functions (name-based)' : ' lines'}</div>
    <div class="muted">Before: ${pctText(r.coverageBefore.total === 0 ? 100 : (r.coverageBefore.covered / r.coverageBefore.total) * 100)}</div>
  </div>
  <div class="card"><h3>Branch coverage</h3>${metricCard(r.coverageAfter.branches, r.coverageBefore.branches)}</div>
  <div class="card"><h3>Method coverage</h3>${metricCard(r.coverageAfter.methods, r.coverageBefore.methods)}</div>
</section>
<section class="panel"><h2>Projects</h2>${projects}</section>
<section class="panel"><h2>Risk hotspots</h2>${hotspotTable(r)}</section>
<section class="panel"><h2>Coverage</h2>${coverageTable(r, linked)}</section>
<section class="panel"><h2>Test cases written</h2>${testCases}</section>
<section class="panel"><h2>Skipped files</h2>${skippedHtml}</section>
<section class="panel"><h2>Source files</h2>${sourceParts || '<p class="muted">No line-level data for these files.</p>'}</section>
</main>
<footer>Generated by Test Automation Agent</footer>
</body></html>`;
}
