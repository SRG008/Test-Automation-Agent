import { CoverageSummary, FileCoverageRow, Report } from './types';

export type Tier = 'high' | 'mid' | 'low' | 'none';

// Percentage of covered over total, or undefined when the file has no measurement.
export function rowRate(row: FileCoverageRow): number | undefined {
  if (row.after.total === undefined) return undefined;
  if (row.after.total === 0) return 100;
  return (row.after.covered / row.after.total) * 100;
}

export function rate(covered: number, total: number): number {
  return total === 0 ? 100 : (covered / total) * 100;
}

// Colour band used for bars and percentages in both the HTML and the PDF report.
export function tierOf(pct: number | undefined): Tier {
  if (pct === undefined) return 'none';
  if (pct >= 80) return 'high';
  if (pct >= 50) return 'mid';
  return 'low';
}

export const pctText = (pct: number | undefined): string => (pct === undefined ? 'n/a' : `${pct.toFixed(1)}%`);

export const summaryRate = (s: CoverageSummary): number => rate(s.covered, s.total);

export interface FolderGroup {
  folder: string;
  rows: FileCoverageRow[];
}

// Files grouped by their folder, like the namespace groups in ReportGenerator. Root files go to '(root)'.
export function groupByFolder(rows: FileCoverageRow[]): FolderGroup[] {
  const groups = new Map<string, FileCoverageRow[]>();
  for (const row of rows) {
    const slash = row.path.lastIndexOf('/');
    const folder = slash < 0 ? '(root)' : row.path.slice(0, slash);
    groups.set(folder, [...(groups.get(folder) ?? []), row]);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([folder, groupRows]) => ({
      folder,
      rows: groupRows.sort((a, b) => a.path.localeCompare(b.path)),
    }));
}

// Files that still have uncovered code, lowest coverage first.
export function hotspots(rows: FileCoverageRow[], limit = 5): FileCoverageRow[] {
  return rows
    .filter(row => {
      const pct = rowRate(row);
      return pct !== undefined && pct < 100;
    })
    .sort((a, b) => (rowRate(a) ?? 0) - (rowRate(b) ?? 0))
    .slice(0, limit);
}

// Summed covered and total counts for a set of files that were measured.
export function sumCounts(rows: FileCoverageRow[]): { covered: number; total: number } {
  return rows.reduce(
    (acc, row) => (row.after.total === undefined ? acc : { covered: acc.covered + row.after.covered, total: acc.total + row.after.total }),
    { covered: 0, total: 0 },
  );
}

export function headline(report: Report): { label: string; pct: number | undefined; covered: number; total: number } {
  const s = report.coverageAfter;
  // 'none' means no coverage tool exists for the language, so there is no percentage to show.
  return {
    label: s.unit === 'none' ? 'Coverage' : s.unit === 'lines' ? 'Line coverage' : 'Function coverage',
    pct: s.unit === 'none' ? undefined : summaryRate(s),
    covered: s.covered,
    total: s.total,
  };
}

// Percent for an optional branch or method count. Undefined when the language doesn't measure it.
export function countsRate(c: { covered: number; total: number } | undefined): number | undefined {
  return c && c.total > 0 ? rate(c.covered, c.total) : undefined;
}
