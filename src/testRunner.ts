import * as fs from 'fs/promises';
import * as path from 'path';
import { askCopilot, extractCode } from './copilot';
import { trackedFiles } from './gitOps';
import { adapterFor, AdapterContext, LanguageAdapter } from './languages/adapters';
import { CoverageSummary, FileCoverage, FileResult, Progress, Project, Report, StepStatus } from './types';

export interface RunConfig {
  repoPath: string;
  branch: string;
  language: string;
  // Framework for projects whose existing tests do not reveal one.
  framework?: string;
  projects: Project[];
}

const STEP_LABELS = [
  'Detecting test layout',
  'Measuring line coverage',
  'Writing and running tests',
  'Measuring coverage again',
];

// Fix attempts per test file before the file is reverted and reported as skipped.
const MAX_FIXES = 3;
const OUTPUT_TAIL = 1500;

interface Target {
  rel: string;
  // Executable lines no test runs. Empty when the file has no coverage data, in which case `functions` applies.
  lines: number[];
  functions: string[];
}

interface Measured extends CoverageSummary {
  targets: Target[];
}


// One project being processed. Adapter paths are relative to the project folder (ctx.repo).
interface Job {
  root: string;
  framework: string;
  adapter: LanguageAdapter;
  ctx: AdapterContext;
  sources: string[];
}

const read = (abs: string): Promise<string> => fs.readFile(abs, 'utf8').catch(() => '');
const escapeName = (name: string): string => name.replace(/\$/g, '\\$');
const tail = (text: string): string => text.slice(-OUTPUT_TAIL).trim();
const joinRepo = (root: string, rel: string): string => (root ? `${root}/${rel}` : rel);
const numbered = (source: string): string =>
  source
    .split('\n')
    .map((line, i) => `${i + 1}: ${line}`)
    .join('\n');

// The deepest project root that contains a file, so a nested project owns its own sources.
function ownerOf(roots: string[], repoRel: string): string {
  return roots
    .filter(r => r === '' || repoRel.startsWith(`${r}/`))
    .sort((a, b) => b.length - a.length)[0];
}

async function measure(job: Job): Promise<Measured> {
  const coverage = job.adapter.coverage ? await job.adapter.coverage(job.ctx) : undefined;
  return coverage ? measureLines(job, coverage) : measureNames(job);
}

// Real line coverage. Coverage tools leave out files that no test loads, so those are targeted by function name.
async function measureLines(job: Job, coverage: FileCoverage[]): Promise<Measured> {
  const byRel = new Map(coverage.map(f => [f.rel, f]));
  const result: Measured = { unit: 'lines', covered: 0, total: 0, filesCovered: 0, filesTotal: 0, targets: [] };
  for (const rel of job.sources) {
    const file = byRel.get(rel);
    if (!file) {
      const functions = job.adapter.listFunctions(await read(path.join(job.ctx.repo, rel)));
      if (functions.length === 0) continue;
      result.filesTotal++;
      result.targets.push({ rel, lines: [], functions });
      continue;
    }
    result.filesTotal++;
    result.total += file.executable;
    result.covered += file.executable - file.uncovered.length;
    if (file.uncovered.length === 0) {
      result.filesCovered++;
    } else {
      result.targets.push({ rel, lines: file.uncovered, functions: [] });
    }
  }
  return result;
}

// Fallback for languages without a coverage tool: a function counts as covered when a test file refers to its name.
async function measureNames(job: Job): Promise<Measured> {
  const { adapter, ctx } = job;
  const testText = (await Promise.all(ctx.files.filter(f => adapter.isTest(f)).map(f => read(path.join(ctx.repo, f))))).join('\n');
  const result: Measured = { unit: 'functions', covered: 0, total: 0, filesCovered: 0, filesTotal: 0, targets: [] };
  for (const rel of job.sources) {
    const functions = adapter.listFunctions(await read(path.join(ctx.repo, rel)));
    if (functions.length === 0) continue;
    const missing = functions.filter(fn => {
      const esc = escapeName(fn);
      const pattern = adapter.testRefPattern?.(esc) ?? `(?<![\\w$])${esc}(?![\\w$])`;
      return !new RegExp(pattern).test(testText);
    });
    result.total += functions.length;
    result.covered += functions.length - missing.length;
    result.filesTotal++;
    if (missing.length === 0) {
      result.filesCovered++;
    } else {
      result.targets.push({ rel, lines: [], functions: missing });
    }
  }
  return result;
}

// Adds up every project. The unit is 'lines' only when every project could measure lines.
async function measureAll(jobs: Job[]): Promise<{ summary: CoverageSummary; targets: Array<{ job: Job; target: Target }> }> {
  const summary: CoverageSummary = { unit: 'lines', covered: 0, total: 0, filesCovered: 0, filesTotal: 0 };
  const targets: Array<{ job: Job; target: Target }> = [];
  for (const job of jobs) {
    const measured = await measure(job);
    if (measured.unit === 'functions') summary.unit = 'functions';
    summary.covered += measured.covered;
    summary.total += measured.total;
    summary.filesCovered += measured.filesCovered;
    summary.filesTotal += measured.filesTotal;
    targets.push(...measured.targets.map(target => ({ job, target })));
  }
  return { summary, targets };
}


function buildPrompt(adapter: LanguageAdapter, ctx: AdapterContext, target: Target, testRel: string, source: string, existing?: string): string {
  const hasLines = target.lines.length > 0;
  const goal = hasLines
    ? `These lines of the source file are not run by any test yet: ${target.lines.join(', ')}. Write tests so that each of them runs, and assert the behaviour rather than only calling the code. Each source line is prefixed with its line number.`
    : `This source file has no tests yet. Cover these functions: ${target.functions.join(', ')}.`;
  return [
    `You are writing ${ctx.framework} unit tests for a ${adapter.language} project.`,
    adapter.testRules(ctx.framework),
    `Source file: ${target.rel}`,
    `Test file: ${testRel}`,
    goal,
    'Reply with the complete test file in one fenced code block and nothing else.',
    '',
    '<source_file>',
    hasLines ? numbered(source) : source,
    '</source_file>',
    ...(existing === undefined
      ? []
      : [
          '',
          'The test file already exists. Keep its tests that are correct, fix any that are wrong, and add or change tests so the goal above is met.',
          '<existing_test_file>',
          existing,
          '</existing_test_file>',
        ]),
  ].join('\n');
}


function buildFixPrompt(adapter: LanguageAdapter, ctx: AdapterContext, target: Target, testRel: string, source: string, testContent: string, output: string): string {
  return [
    `These ${ctx.framework} tests for a ${adapter.language} project fail.`,
    adapter.testRules(ctx.framework),
    `Source file: ${target.rel}`,
    `Test file: ${testRel}`,
    'Fix the test file so its tests pass. Only change the test file, never the source file. Do not delete tests to make them pass.',
    'Reply with the complete test file in one fenced code block and nothing else.',
    '',
    '<source_file>',
    source,
    '</source_file>',
    '',
    '<test_file>',
    testContent,
    '</test_file>',
    '',
    '<test_output>',
    tail(output),
    '</test_output>',
  ].join('\n');
}

// Writes tests for one source file, fixes them up to MAX_FIXES times, and reverts the file if it still fails.
async function writeAndVerify(
  adapter: LanguageAdapter,
  ctx: AdapterContext,
  target: Target,
  testRel: string,
  isCancelled: () => boolean,
): Promise<FileResult> {
  const abs = path.join(ctx.repo, testRel);
  const original = await fs.readFile(abs, 'utf8').catch(() => undefined);
  const source = await read(path.join(ctx.repo, target.rel));

  const save = async (content: string) => {
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content, 'utf8');
    if (!ctx.files.includes(testRel)) ctx.files.push(testRel);
  };

  let content = extractCode(await askCopilot(buildPrompt(adapter, ctx, target, testRel, source, original)));
  await save(content);
  let run = await adapter.runTests(ctx, testRel);

  for (let attempt = 0; run.code !== 0 && attempt < MAX_FIXES; attempt++) {
    if (isCancelled()) throw new Error('Run cancelled.');
    content = extractCode(await askCopilot(buildFixPrompt(adapter, ctx, target, testRel, source, content, run.output)));
    await save(content);
    run = await adapter.runTests(ctx, testRel);
  }

  if (run.code === 0) {
    return { path: testRel, status: 'written' };
  }

  if (original === undefined) {
    await fs.rm(abs, { force: true });
    ctx.files = ctx.files.filter(f => f !== testRel);
  } else {
    await fs.writeFile(abs, original, 'utf8');
  }
  return {
    path: testRel,
    status: 'skipped',
    note: `Still failing after ${MAX_FIXES} fix attempts, so the file was reverted.\n${tail(run.output)}`,
  };
}

export async function runGeneration(
  config: RunConfig,
  onProgress: (p: Progress) => void,
  isCancelled: () => boolean,
): Promise<Report> {
  const adapter = adapterFor(config.language);
  const projects = config.projects.length
    ? config.projects
    : [{ language: config.language, root: '', hasTests: false, sources: 0 }];
  const roots = projects.map(p => p.root);
  const steps: StepStatus[] = STEP_LABELS.map(label => ({ label, status: 'pending' }));
  const snapshot = (done: number, current?: string): Progress => ({
    steps: steps.map(s => ({ ...s })),
    done,
    total: steps.length,
    current,
  });
  const begin = (i: number, current?: string) => {
    if (isCancelled()) throw new Error('Run cancelled.');
    steps[i].status = 'active';
    onProgress(snapshot(i, current ?? steps[i].label));
  };
  const finish = (i: number) => {
    steps[i].status = 'done';
    onProgress(snapshot(i + 1));
  };

  begin(0);
  const tracked = await trackedFiles(config.repoPath);
  const jobs: Job[] = [];
  for (const project of projects) {
    const framework = project.framework ?? config.framework;
    if (!framework) throw new Error('Choose a test framework first.');
    const prefix = project.root ? `${project.root}/` : '';
    const ctx: AdapterContext = {
      repo: path.join(config.repoPath, project.root),
      framework,
      files: tracked.filter(f => f.startsWith(prefix)).map(f => f.slice(prefix.length)),
    };
    const setupError = await adapter.ensureTooling(ctx);
    if (setupError) throw new Error(`${project.root || 'Repository root'}: ${setupError}`);
    const sources = ctx.files.filter(
      f => adapter.isSource(f) && ownerOf(roots, joinRepo(project.root, f)) === project.root,
    );
    jobs.push({ root: project.root, framework, adapter, ctx, sources });
  }
  finish(0);

  begin(1);
  const before = await measureAll(jobs);
  finish(1);

  begin(2);
  const files: FileResult[] = [];
  const handled = new Set<string>();
  for (const { job, target } of before.targets) {
    if (isCancelled()) throw new Error('Run cancelled.');
    const testRel = job.adapter.testPathFor(target.rel, job.ctx);
    const shown = joinRepo(job.root, testRel);
    onProgress(snapshot(2, `Writing ${shown}`));
    if (handled.has(shown)) {
      files.push({ path: shown, status: 'skipped', note: 'Another source file in this run already writes this test file.' });
      continue;
    }
    handled.add(shown);
    const result = await writeAndVerify(job.adapter, job.ctx, target, testRel, isCancelled);
    files.push({ ...result, path: shown });
  }
  finish(2);

  begin(3);
  const after = await measureAll(jobs);
  finish(3);

  return {
    branch: config.branch,
    projects: jobs.map(j => `${j.root || 'Repository root'} · ${j.adapter.language} · ${j.framework}`),
    filesWritten: files.filter(f => f.status === 'written').length,
    filesSkipped: files.filter(f => f.status === 'skipped').length,
    coverageBefore: before.summary,
    coverageAfter: after.summary,
    files,
  };
}

const pctOf = (s: CoverageSummary): number => (s.total === 0 ? 100 : Math.round((s.covered / s.total) * 100));
const coverageCell = (s: CoverageSummary): string => `${pctOf(s)}% (${s.covered}/${s.total})`;

export function renderReportMarkdown(r: Report): string {
  const projectLines = r.projects.map(p => `- ${p}`);
  const fileLines = r.files.length
    ? r.files.flatMap(f => {
        const header = `- \`${f.path}\`: ${f.status === 'written' ? 'written, tests pass' : 'skipped'}`;
        if (!f.note) return [header];
        return [header, '', '  ```', ...f.note.split('\n').map(l => `  ${l}`), '  ```'];
      })
    : ['_No test files written._'];
  const lines = r.coverageAfter.unit === 'lines'
    ? 'Line coverage counts executable lines that no test runs, as measured by each project\'s coverage tool.'
    : 'Some projects have no coverage tool here, so they are measured by function name: a function counts as covered when a test file mentions its name.';
  return [
    '# Unit Test Generation Report',
    '',
    `**Branch:** \`${r.branch}\``,
    '',
    '| Metric | Before | After |',
    '|---|---|---|',
    `| ${r.coverageAfter.unit === 'lines' ? 'Line coverage' : 'Function coverage'} | ${coverageCell(r.coverageBefore)} | ${coverageCell(r.coverageAfter)} |`,
    `| Files fully covered | ${r.coverageBefore.filesCovered}/${r.coverageBefore.filesTotal} | ${r.coverageAfter.filesCovered}/${r.coverageAfter.filesTotal} |`,
    `| Files written | | ${r.filesWritten} |`,
    `| Files skipped | | ${r.filesSkipped} |`,
    '',
    lines,
    '',
    '## Projects',
    '',
    ...projectLines,
    '',
    '## Files',
    '',
    ...fileLines,
  ].join('\n');
}

