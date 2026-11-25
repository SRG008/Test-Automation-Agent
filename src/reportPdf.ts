import * as fs from 'fs';
import PDFDocument = require('pdfkit');
import { Report } from './types';
import { countsRate, groupByFolder, headline, hotspots, pctText, rowRate, sumCounts, Tier, tierOf } from './reportData';

type Doc = PDFKit.PDFDocument;

const MARGIN = 40;
const ROW = 16;
const COLORS = {
  ink: '#1f2937',
  muted: '#6b7280',
  band: '#4338ca',
  track: '#e5e7eb',
  head: '#eef2ff',
  group: '#f8fafc',
  cov: '#dcfce7',
  unc: '#fee2e2',
};
const FILL: Record<Tier, string> = { high: '#22c55e', mid: '#f59e0b', low: '#ef4444', none: '#d1d5db' };
const TEXT: Record<Tier, string> = { high: '#15803d', mid: '#b45309', low: '#b91c1c', none: '#9ca3af' };

// Writes the PDF version of the report. `sources` maps each file in report.coverageFiles to its lines.
export function writeReportPdf(r: Report, sources: Map<string, string[]>, file: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: MARGIN, info: { Title: 'Unit Test Report', Author: 'Test Automation Agent' } });
    const out = fs.createWriteStream(file);
    out.on('finish', () => resolve());
    out.on('error', reject);
    doc.on('error', reject);
    doc.pipe(out);

    drawHeader(doc, r);
    drawCards(doc, r);
    drawHotspots(doc, r);
    drawCoverage(doc, r);
    drawSkipped(doc, r);
    drawSources(doc, r, sources);

    doc.end();
  });
}

function drawHeader(doc: Doc, r: Report): void {
  doc.rect(0, 0, doc.page.width, 64).fill(COLORS.band);
  doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(18).text('Unit Test Report', MARGIN, 18, { lineBreak: false });
  doc.font('Helvetica').fontSize(9).text(`Test Automation Agent · generated ${r.generatedAt}`, MARGIN, 42, { lineBreak: false });
  doc.y = 80;
  doc.fillColor(COLORS.ink);
}

// Three cards like the ReportGenerator summary: information, the headline percentage, and the unmeasured metrics.
function drawCards(doc: Doc, r: Report): void {
  const gap = 10;
  const w = (contentWidth(doc) - gap * 2) / 3;
  const top = doc.y;
  const h = 96;
  const x = [MARGIN, MARGIN + w + gap, MARGIN + (w + gap) * 2];
  x.forEach(cx => doc.rect(cx, top, w, h).lineWidth(0.8).strokeColor(COLORS.track).stroke());

  const info = [
    ['Branch', r.branch],
    ['Files measured', String(r.fileCoverage.length)],
    ['Tests written', String(r.filesWritten)],
    ['Skipped', String(r.filesSkipped)],
  ];
  doc.font('Helvetica-Bold').fontSize(8).fillColor(COLORS.muted).text('INFORMATION', x[0] + 10, top + 10, { lineBreak: false });
  info.forEach(([k, v], i) => {
    doc.font('Helvetica').fontSize(8).fillColor(COLORS.muted).text(k, x[0] + 10, top + 24 + i * 16, { lineBreak: false });
    doc.font('Helvetica-Bold').fillColor(COLORS.ink).text(clipEnd(v, 26), x[0] + 90, top + 24 + i * 16, { width: w - 100, lineBreak: false });
  });

  const head = headline(r);
  const tier = tierOf(head.pct);
  doc.font('Helvetica-Bold').fontSize(8).fillColor(COLORS.muted).text(head.label.toUpperCase(), x[1] + 10, top + 10, { lineBreak: false });
  doc.font('Helvetica-Bold').fontSize(28).fillColor(TEXT[tier]).text(pctText(head.pct), x[1] + 10, top + 24, { lineBreak: false });
  drawBar(doc, x[1] + 10, top + 62, w - 20, head.pct ?? 0, tier, 8);
  doc.font('Helvetica').fontSize(8).fillColor(COLORS.muted).text(
    head.pct === undefined
      ? 'No coverage tool is known for this language.'
      : `${head.covered} covered of ${head.total}${r.coverageAfter.unit === 'functions' ? ' functions (name-based)' : ' lines'}`,
    x[1] + 10,
    top + 78,
    { width: w - 20, lineBreak: false },
  );

  const branch = countsRate(r.coverageAfter.branches);
  const method = countsRate(r.coverageAfter.methods);
  doc.font('Helvetica-Bold').fontSize(8).fillColor(COLORS.muted).text('BRANCH AND METHOD', x[2] + 10, top + 10, { lineBreak: false });
  doc.font('Helvetica-Bold').fontSize(14).fillColor(TEXT[tierOf(branch)]).text(`Branch: ${pctText(branch)}`, x[2] + 10, top + 30, { lineBreak: false });
  doc.fillColor(TEXT[tierOf(method)]).text(`Method: ${pctText(method)}`, x[2] + 10, top + 52, { lineBreak: false });
  if (branch === undefined && method === undefined) {
    doc.font('Helvetica').fontSize(8).fillColor(COLORS.muted).text('Not measured for this language yet.', x[2] + 10, top + 76, { lineBreak: false });
  }

  doc.y = top + h + 14;
}

function drawHotspots(doc: Doc, r: Report): void {
  section(doc, 'Risk hotspots');
  const rows = hotspots(r.fileCoverage);
  if (rows.length === 0) {
    paragraph(doc, 'No files with uncovered code.', COLORS.muted);
    return;
  }
  tableRow(doc, [
    { text: 'File', width: 250, bold: true },
    { text: 'Coverage', width: 60, bold: true, align: 'right' },
    { text: 'Uncovered lines', width: 185, bold: true },
  ], COLORS.head);
  for (const row of rows) {
    const pct = rowRate(row);
    tableRow(doc, [
      { text: clipStart(row.path, 46), width: 250 },
      { text: pctText(pct), width: 60, align: 'right', color: TEXT[tierOf(pct)] },
      { text: clipEnd(row.missing || '—', 36), width: 185 },
    ]);
  }
}

// Files grouped by folder with a bar per row, lowest coverage highlighted by colour.
function drawCoverage(doc: Doc, r: Report): void {
  section(doc, 'Coverage');
  if (r.fileCoverage.length === 0) {
    paragraph(doc, 'No source files were measured.', COLORS.muted);
    return;
  }
  const head = [
    { text: 'Name', width: 170, bold: true },
    { text: 'Covered', width: 48, bold: true, align: 'right' as const },
    { text: 'Uncovered', width: 60, bold: true, align: 'right' as const },
    { text: 'Coverable', width: 62, bold: true, align: 'right' as const },
    { text: 'Before', width: 52, bold: true, align: 'right' as const },
    { text: 'Coverage', width: 70, bold: true },
    { text: '', width: 33 },
  ];
  tableRow(doc, head, COLORS.head);

  for (const group of groupByFolder(r.fileCoverage)) {
    const sums = sumCounts(group.rows);
    const pct = sums.total === 0 ? 100 : (sums.covered / sums.total) * 100;
    coverageRow(doc, clipStart(group.folder, 30), {
      covered: String(sums.covered),
      uncovered: String(sums.total - sums.covered),
      coverable: String(sums.total),
      before: '',
      pct,
    }, true, COLORS.group);
    for (const row of group.rows) {
      const after = row.after;
      const b = row.before;
      const beforePct = b?.total === undefined ? undefined : b.total === 0 ? 100 : (b.covered / b.total) * 100;
      coverageRow(doc, clipStart(row.path, 30), {
        covered: after.total === undefined ? '—' : String(after.covered),
        uncovered: after.total === undefined ? '—' : String(after.total - after.covered),
        coverable: after.total === undefined ? '—' : String(after.total),
        before: pctText(beforePct),
        pct: rowRate(row),
      }, false);
    }
  }
}

interface CoverageValues {
  covered: string;
  uncovered: string;
  coverable: string;
  before: string;
  pct?: number;
}

function coverageRow(doc: Doc, name: string, v: CoverageValues, bold: boolean, fill?: string): void {
  ensureSpace(doc, ROW);
  const y = doc.y;
  const tier = tierOf(v.pct);
  tableRow(doc, [
    { text: name, width: 170, bold },
    { text: v.covered, width: 48, align: 'right', bold },
    { text: v.uncovered, width: 60, align: 'right', bold },
    { text: v.coverable, width: 62, align: 'right', bold },
    { text: v.before, width: 52, align: 'right' },
    { text: '', width: 70 },
    { text: pctText(v.pct), width: 33, align: 'right', bold, color: TEXT[tier] },
  ], fill);
  drawBar(doc, MARGIN + 170 + 48 + 60 + 62 + 52 + 4, y + 4, 62, v.pct, tier, 8);
}

function drawSkipped(doc: Doc, r: Report): void {
  const skipped = r.files.filter(f => f.status === 'skipped');
  if (skipped.length === 0) return;
  section(doc, 'Skipped files');
  for (const file of skipped) {
    paragraph(doc, `${file.path}${file.note ? ` — ${file.note}` : ''}`, '#b91c1c');
  }
}

// One block per source file: covered lines in green, uncovered lines in red.
function drawSources(doc: Doc, r: Report, sources: Map<string, string[]>): void {
  section(doc, 'Source files');
  const withLines = r.coverageFiles.filter(f => sources.has(f.rel));
  if (withLines.length === 0) {
    paragraph(doc, 'No line-level data for these files.', COLORS.muted);
    return;
  }
  for (const file of withLines) {
    ensureSpace(doc, 40);
    doc.moveDown(0.5);
    const pct = file.executable === 0 ? 100 : (file.covered.length / file.executable) * 100;
    doc.font('Helvetica-Bold').fontSize(10).fillColor(COLORS.ink).text(`${file.rel}`, { continued: true, lineBreak: false });
    doc.font('Helvetica').fillColor(COLORS.muted).text(`   ${file.covered.length}/${file.executable} lines covered (${pctText(pct)})`);
    doc.moveDown(0.2);

    const covered = new Set(file.covered);
    const uncovered = new Set(file.uncovered);
    (sources.get(file.rel) ?? []).forEach((text, i) => {
      const n = i + 1;
      const fill = uncovered.has(n) ? COLORS.unc : covered.has(n) ? COLORS.cov : undefined;
      ensureSpace(doc, 10);
      const y = doc.y;
      if (fill) doc.rect(MARGIN, y, contentWidth(doc), 10).fill(fill);
      doc.font('Courier').fontSize(7).fillColor(COLORS.muted).text(String(n), MARGIN, y + 2, { width: 32, align: 'right', lineBreak: false });
      doc.fillColor(COLORS.ink).text(text.replace(/\t/g, '    ').replace(/\r$/, ''), MARGIN + 40, y + 2, { width: contentWidth(doc) - 44, lineBreak: false });
      doc.y = y + 10;
    });
  }
}

interface Cell {
  text: string;
  width: number;
  bold?: boolean;
  align?: 'left' | 'right';
  color?: string;
}

// One table row. Cells are laid out left to right at the widths given.
function tableRow(doc: Doc, cells: Cell[], fill?: string): void {
  ensureSpace(doc, ROW);
  const y = doc.y;
  if (fill) doc.rect(MARGIN, y, contentWidth(doc), ROW).fill(fill);
  let x = MARGIN;
  for (const cell of cells) {
    doc
      .font(cell.bold ? 'Helvetica-Bold' : 'Helvetica')
      .fontSize(8)
      .fillColor(cell.color ?? COLORS.ink)
      .text(cell.text, x + 4, y + 4, { width: cell.width - 8, align: cell.align ?? 'left', lineBreak: false });
    x += cell.width;
  }
  doc.y = y + ROW;
}

function drawBar(doc: Doc, x: number, y: number, w: number, pct: number | undefined, tier: Tier, h: number): void {
  doc.rect(x, y, w, h).fill(COLORS.track);
  const filled = pct === undefined ? 0 : Math.min(100, Math.max(0, pct));
  if (filled > 0) doc.rect(x, y, (w * filled) / 100, h).fill(FILL[tier]);
}

function section(doc: Doc, title: string): void {
  ensureSpace(doc, 40);
  doc.moveDown(0.6);
  doc.font('Helvetica-Bold').fontSize(12).fillColor(COLORS.ink).text(title, { lineBreak: false });
  doc.moveDown(0.4);
}

function paragraph(doc: Doc, text: string, color: string = COLORS.ink): void {
  ensureSpace(doc, ROW);
  doc.font('Helvetica').fontSize(9).fillColor(color).text(text, { width: contentWidth(doc) });
}

const clipEnd = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
const clipStart = (text: string, max: number): string => (text.length > max ? `…${text.slice(text.length - max + 1)}` : text);
const contentWidth = (doc: Doc): number => doc.page.width - MARGIN * 2;

function ensureSpace(doc: Doc, height: number): void {
  if (doc.y + height > doc.page.height - MARGIN) doc.addPage();
}
