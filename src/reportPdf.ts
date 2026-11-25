import * as fs from 'fs';
import PDFDocument = require('pdfkit');
import { CoverageSummary, FileCount, Report } from './types';

const COLORS = {
  ink: '#1f2937',
  muted: '#6b7280',
  band: '#4338ca',
  accent: '#7c3aed',
  ok: '#15803d',
  fail: '#b91c1c',
};
const MARGIN = 50;
const ROW = 18;

const pctOf = (s: CoverageSummary): number => (s.total === 0 ? 100 : Math.round((s.covered / s.total) * 100));
const coverageCell = (s: CoverageSummary): string => `${pctOf(s)}% (${s.covered}/${s.total})`;

// Writes the report to the given file, replacing any earlier report there.
export function writeReportPdf(r: Report, file: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: MARGIN, info: { Title: 'Unit Test Report', Author: 'Test Automation Agent' } });
    const out = fs.createWriteStream(file);
    out.on('finish', () => resolve());
    out.on('error', reject);
    doc.on('error', reject);
    doc.pipe(out);

    drawHeader(doc, r);
    drawSummary(doc, r);
    drawFileCoverage(doc, r);
    drawProjects(doc, r);
    drawTestCases(doc, r);
    drawSkipped(doc, r);
    drawRemaining(doc, r);

    doc.end();
  });
}

function drawHeader(doc: PDFKit.PDFDocument, r: Report): void {
  doc.rect(0, 0, doc.page.width, 84).fill(COLORS.band);
  doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(20).text('Unit Test Report', MARGIN, 26);
  doc.font('Helvetica').fontSize(10).text(`Test Automation Agent · generated ${r.generatedAt}`, MARGIN, 54);
  doc.fillColor(COLORS.ink).y = 104;
  doc.font('Helvetica').fontSize(10).fillColor(COLORS.muted).text(`Branch: ${r.branch}`);
  doc.moveDown(1.2);
}

function drawSummary(doc: PDFKit.PDFDocument, r: Report): void {
  section(doc, 'Summary');
  const lineMetric = r.coverageAfter.unit === 'lines';
  tableRow(doc, ['Metric', 'Before', 'After'], true);
  tableRow(doc, [lineMetric ? 'Line coverage' : 'Function coverage', coverageCell(r.coverageBefore), coverageCell(r.coverageAfter)]);
  tableRow(doc, [
    'Files fully covered',
    `${r.coverageBefore.filesCovered}/${r.coverageBefore.filesTotal}`,
    `${r.coverageAfter.filesCovered}/${r.coverageAfter.filesTotal}`,
  ]);
  tableRow(doc, ['Test files written', '', String(r.filesWritten)]);
  tableRow(doc, ['Test files skipped', '', String(r.filesSkipped)]);
  doc.moveDown(0.6);
  const note = lineMetric
    ? 'Line coverage counts executable lines that no test runs, as measured by each project\'s coverage tool.'
    : 'Some projects have no coverage tool here, so they are measured by function name: a function counts as covered when a test file mentions its name.';
  paragraph(doc, note, COLORS.muted);
}

// Lowest coverage first, so the files that still need tests are at the top.
function drawFileCoverage(doc: PDFKit.PDFDocument, r: Report): void {
  section(doc, 'Coverage by file');
  if (r.fileCoverage.length === 0) {
    paragraph(doc, 'No source files were measured.', COLORS.muted);
    return;
  }
  const widths = [190, 70, 70, 75, 90];
  tableRow(doc, ['File', 'Before', 'After', 'Covered', 'Uncovered'], true, widths);
  for (const row of r.fileCoverage) {
    tableRow(
      doc,
      [clip(row.path, 36), pctText(row.before), pctText(row.after), countText(row.after), clip(row.missing || '—', 18)],
      false,
      widths,
    );
  }
}

const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
const pctText = (c?: FileCount): string => {
  if (!c) return '—';
  if (c.total === undefined) return 'n/a';
  return c.total === 0 ? '100%' : `${Math.round((c.covered / c.total) * 100)}%`;
};
const countText = (c: FileCount): string => (c.total === undefined ? '—' : `${c.covered}/${c.total}`);

function drawProjects(doc: PDFKit.PDFDocument, r: Report): void {
  section(doc, 'Projects');
  r.projects.forEach(p => paragraph(doc, `• ${p}`));
}

function drawTestCases(doc: PDFKit.PDFDocument, r: Report): void {
  section(doc, 'Test cases written');
  if (r.testCases.length === 0) {
    paragraph(doc, 'No test files were written in this run.', COLORS.muted);
    return;
  }
  for (const file of r.testCases) {
    ensureSpace(doc, ROW * 2);
    doc.font('Helvetica-Bold').fontSize(11).fillColor(COLORS.accent).text(file.path);
    if (file.names.length === 0) {
      paragraph(doc, 'No test case names were detected in this file.', COLORS.muted);
    } else {
      file.names.forEach((name, i) => paragraph(doc, `${i + 1}. ${name}`));
    }
    doc.moveDown(0.4);
  }
}

function drawSkipped(doc: PDFKit.PDFDocument, r: Report): void {
  const skipped = r.files.filter(f => f.status === 'skipped');
  if (skipped.length === 0) return;
  section(doc, 'Skipped files');
  for (const file of skipped) {
    ensureSpace(doc, ROW * 2);
    doc.font('Helvetica-Bold').fontSize(10).fillColor(COLORS.fail).text(file.path);
    if (file.note) paragraph(doc, file.note, COLORS.muted);
  }
}

function drawRemaining(doc: PDFKit.PDFDocument, r: Report): void {
  section(doc, 'Source files with uncovered code');
  if (r.remaining.length === 0) {
    paragraph(doc, 'Every measured source file is fully covered.', COLORS.ok);
    return;
  }
  r.remaining.forEach(rel => paragraph(doc, `• ${rel}`));
}

function section(doc: PDFKit.PDFDocument, title: string): void {
  ensureSpace(doc, 40);
  doc.moveDown(0.6);
  doc.font('Helvetica-Bold').fontSize(13).fillColor(COLORS.ink).text(title);
  doc.moveDown(0.3);
}

function paragraph(doc: PDFKit.PDFDocument, text: string, color: string = COLORS.ink): void {
  ensureSpace(doc, ROW);
  doc.font('Helvetica').fontSize(10).fillColor(color).text(text, { width: contentWidth(doc) });
}

// Draws one row of a table. The first column is wider because it holds metric and file names.
function tableRow(doc: PDFKit.PDFDocument, cells: string[], header = false, widths = [260, 120, 120]): void {
  ensureSpace(doc, ROW);
  const y = doc.y;
  if (header) doc.rect(MARGIN, y - 2, contentWidth(doc), ROW).fill('#eef2ff');
  let x = MARGIN;
  cells.forEach((cell, i) => {
    doc
      .font(header ? 'Helvetica-Bold' : 'Helvetica')
      .fontSize(10)
      .fillColor(COLORS.ink)
      .text(cell, x + 4, y, { width: widths[i] - 8, lineBreak: false });
    x += widths[i];
  });
  doc.y = y + ROW;
}

function contentWidth(doc: PDFKit.PDFDocument): number {
  return doc.page.width - MARGIN * 2;
}

function ensureSpace(doc: PDFKit.PDFDocument, height: number): void {
  if (doc.y + height > doc.page.height - MARGIN) doc.addPage();
}
