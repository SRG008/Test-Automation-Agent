import * as fs from 'fs/promises';
import * as path from 'path';
import { askCopilot, extractCode } from './copilot';
import { trackedFiles } from './gitOps';
import { adapterFor, AdapterContext, LanguageAdapter } from './languages/adapters';
import { CoverageSummary, Counts, FileCount, FileCoverage, FileCoverageRow, FileResult, LiveStatus, Progress, Project, Report, StepStatus } from './types';

export interface RunConfig {
  repoPath: string;
  branch: string;
  language: string;
  // Framework for projects whose existing tests do not reveal one.
  framework?: string;
  projects: Project[];
  // Repo-relative source files to write tests for. Undefined means every source file.
  selected?: string[];
}

const STEP_LABELS = [
  'Detecting test layout',
  'Measuring line coverage',
  'Writing and running tests',
  'Measuring coverage again',
];
// Rough durations in seconds. The writing step is scaled by the number of files.
const STEP_ESTIMATES = [20, 30, 0, 30];
const SECONDS_PER_TEST_FILE = 60;

// Test case declarations for the frameworks the agent writes. Group 1 is the test name.
const TEST_NAME_PATTERNS: RegExp[] = [
  /^\s*def (test\w*)\s*\(/gm, // Python
  /\b(?:it|test)\(\s*['"`]([^'"`]+)['"`]/g, // Jest, Vitest, Mocha
  /@(?:Parameterized)?Test\b[^{;]*?\bvoid\s+(\w+)\s*\(/g, // JUnit, TestNG
  /\[(?:Fact|Theory|Test|TestMethod|TestCase)\b[^\]]*\][^{;]*?\b(?:void|Task)\s+(\w+)\s*\(/g, // xUnit, NUnit, MSTest
  /^func (Test\w*)\s*\(/gm, // Go
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

interface FileMeasure {
  rel: string;
  covered: number;
  total?: number;
  missing: string;
  lines?: FileCoverage; // set only when the file has line coverage data
}

interface Measured extends CoverageSummary {
  targets: Target[];
  files: FileMeasure[];
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
// Adds two counts; the sum is undefined as soon as either side is not measured.
const addCounts = (a: Counts | undefined, b: Counts | undefined): Counts | undefined =>
  a && b ? { covered: a.covered + b.covered, total: a.total + b.total } : undefined;
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

// Every source file of the language that the agent can write tests for, as repo-relative paths.
export async function listSourceFiles(repoPath: string, projects: Project[], language: string): Promise<string[]> {
  const adapter = adapterFor(language);
  const tracked = await trackedFiles(repoPath);
  const roots = projects.map(p => p.root);
  const found = new Set<string>();
  for (const project of projects) {
    const prefix = project.root ? `${project.root}/` : '';
    for (const f of tracked) {
      if (!f.startsWith(prefix)) continue;
      if (adapter.isSource(f.slice(prefix.length)) && ownerOf(roots, f) === project.root) found.add(f);
    }
  }
  return [...found].sort();
}

async function measure(job: Job): Promise<Measured> {
  const coverage = job.adapter.coverage ? await job.adapter.coverage(job.ctx) : undefined;
  return coverage ? measureLines(job, coverage) : measureNames(job);
}

// Real line coverage. Coverage tools leave out files that no test loads, so those are targeted by function name.
// Coverage tools may report paths with other slashes, a "./" prefix, or relative to a different folder.
function normalizeRel(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\//, '');
}

function findCoverage(coverage: FileCoverage[], rel: string): FileCoverage | undefined {
  const want = normalizeRel(rel);
  const exact = coverage.find(f => normalizeRel(f.rel) === want);
  if (exact) return exact;
  return coverage.find(f => {
    const have = normalizeRel(f.rel);
    return have.endsWith('/' + want) || want.endsWith('/' + have);
  });
}

async function measureLines(job: Job, coverage: FileCoverage[]): Promise<Measured> {
  const result: Measured = { unit: 'lines', covered: 0, total: 0, filesCovered: 0, filesTotal: 0, targets: [], files: [] };
  let branches: Counts | undefined = { covered: 0, total: 0 };
  let methods: Counts | undefined = { covered: 0, total: 0 };
  for (const rel of job.sources) {
    const file = findCoverage(coverage, rel);
    if (!file) {
      const functions = job.adapter.listFunctions(await read(path.join(job.ctx.repo, rel)));
      if (functions.length === 0) continue;
      result.filesTotal++;
      result.targets.push({ rel, lines: [], functions });
      result.files.push({ rel, covered: 0, missing: `no coverage data for: ${functions.join(', ')}` });
      continue;
    }
    result.filesTotal++;
    result.total += file.executable;
    result.covered += file.executable - file.uncovered.length;
    branches = addCounts(branches, file.branches);
    methods = addCounts(methods, file.methods);
    result.files.push({
      rel,
      covered: file.executable - file.uncovered.length,
      total: file.executable,
      missing: file.uncovered.join(', '),
      lines: { ...file, rel },
    });
    if (file.uncovered.length === 0) {
      result.filesCovered++;
    } else {
      result.targets.push({ rel, lines: file.uncovered, functions: [] });
    }
  }
  result.branches = branches;
  result.methods = methods;
  return result;
}


// Fallback for languages without a coverage tool: a function counts as covered when a test file refers to its name.
async function measureNames(job: Job): Promise<Measured> {
  const { adapter, ctx } = job;
  const testText = (await Promise.all(ctx.files.filter(f => adapter.isTest(f)).map(f => read(path.join(ctx.repo, f))))).join('\n');
  const result: Measured = { unit: 'functions', covered: 0, total: 0, filesCovered: 0, filesTotal: 0, targets: [], files: [] };
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
    result.files.push({ rel, covered: functions.length - missing.length, total: functions.length, missing: missing.join(', ') });
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
async function measureAll(jobs: Job[]): Promise<{ summary: CoverageSummary; targets: Array<{ job: Job; target: Target }>; files: FileMeasure[] }> {
  const summary: CoverageSummary = {
    unit: 'lines',
    covered: 0,
    total: 0,
    filesCovered: 0,
    filesTotal: 0,
    branches: { covered: 0, total: 0 },
    methods: { covered: 0, total: 0 },
  };
  const targets: Array<{ job: Job; target: Target }> = [];
  const files: FileMeasure[] = [];
  for (const job of jobs) {
    const measured = await measure(job);
    if (measured.unit === 'functions') summary.unit = 'functions';
    summary.covered += measured.covered;
    summary.total += measured.total;
    summary.filesCovered += measured.filesCovered;
    summary.filesTotal += measured.filesTotal;
    summary.branches = addCounts(summary.branches, measured.branches);
    summary.methods = addCounts(summary.methods, measured.methods);
    targets.push(...measured.targets.map(target => ({ job, target })));
    files.push(
      ...measured.files.map(f => ({
        ...f,
        rel: joinRepo(job.root, f.rel),
        lines: f.lines && { ...f.lines, rel: joinRepo(job.root, f.rel) },
      })),
    );
  }
  return { summary, targets, files };
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
  setPhase: (phase: string, tests?: string[]) => void,
): Promise<FileResult> {
  const abs = path.join(ctx.repo, testRel);
  const original = await fs.readFile(abs, 'utf8').catch(() => undefined);
  const source = await read(path.join(ctx.repo, target.rel));

  const save = async (content: string) => {
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content, 'utf8');
    if (!ctx.files.includes(testRel)) ctx.files.push(testRel);
    setPhase('Running tests', testCaseNames(content));
  };

  setPhase('Asking Copilot for tests');
  let content = extractCode(await askCopilot(buildPrompt(adapter, ctx, target, testRel, source, original)));
  await save(content);
  let run = await adapter.runTests(ctx, testRel);

  for (let attempt = 0; run.code !== 0 && attempt < MAX_FIXES; attempt++) {
    if (isCancelled()) throw new Error('Run cancelled.');
    setPhase(`Fixing failing tests (attempt ${attempt + 1} of ${MAX_FIXES})`);
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
  const selected = config.selected ? new Set(config.selected) : undefined;
  const runStartedAt = Date.now();
  const steps: StepStatus[] = STEP_LABELS.map((label, i) => ({ label, status: 'pending', estimateSec: STEP_ESTIMATES[i] }));
  let live: LiveStatus | undefined;
  const snapshot = (done: number): Progress => ({
    steps: steps.map(s => ({ ...s })),
    done,
    total: steps.length,
    live: live && { ...live, tests: [...live.tests] },
    startedAt: runStartedAt,
  });
  const begin = (i: number) => {
    if (isCancelled()) throw new Error('Run cancelled.');
    steps[i].status = 'active';
    steps[i].startedAt = Date.now();
    onProgress(snapshot(i));
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
      f =>
        adapter.isSource(f) &&
        ownerOf(roots, joinRepo(project.root, f)) === project.root &&
        (!selected || selected.has(joinRepo(project.root, f))),
    );
    jobs.push({ root: project.root, framework, adapter, ctx, sources });
  }
  finish(0);

  begin(1);
  const before = await measureAll(jobs);
  finish(1);

  steps[2].estimateSec = SECONDS_PER_TEST_FILE * before.targets.length;
  begin(2);
  const files: FileResult[] = [];
  const handled = new Set<string>();
  const planned = before.targets.length;
  for (const [i, { job, target }] of before.targets.entries()) {
    if (isCancelled()) throw new Error('Run cancelled.');
    const testRel = job.adapter.testPathFor(target.rel, job.ctx);
    const shown = joinRepo(job.root, testRel);
    const sourceShown = joinRepo(job.root, target.rel);
    if (handled.has(shown)) {
      files.push({ path: shown, status: 'skipped', note: 'Another source file in this run already writes this test file.' });
      continue;
    }
    handled.add(shown);
    live = { index: i + 1, total: planned, file: sourceShown, phase: 'Starting', tests: [] };
    const setPhase = (phase: string, tests?: string[]) => {
      live = { index: i + 1, total: planned, file: sourceShown, phase, tests: tests ?? live?.tests ?? [] };
      onProgress(snapshot(2));
    };
    setPhase('Starting');
    const result = await writeAndVerify(job.adapter, job.ctx, target, testRel, isCancelled, setPhase);
    files.push({ ...result, path: shown });
  }
  live = undefined;
  finish(2);

  begin(3);
  const after = await measureAll(jobs);
  finish(3);

  const testCases = await Promise.all(
    files
      .filter(f => f.status === 'written')
      .map(async f => ({ path: f.path, names: testCaseNames(await read(path.join(config.repoPath, f.path))) })),
  );

  const beforeByPath = new Map(before.files.map(f => [f.rel, f]));
  const ratio = (c: FileCount): number => (c.total === undefined ? 0 : c.total === 0 ? 1 : c.covered / c.total);
  const fileCoverage: FileCoverageRow[] = after.files
    .map(f => {
      const b = beforeByPath.get(f.rel);
      return {
        path: f.rel,
        before: b && { covered: b.covered, total: b.total },
        after: { covered: f.covered, total: f.total },
        missing: f.missing,
      };
    })
    .sort((a, b) => ratio(a.after) - ratio(b.after));

  return {
    branch: config.branch,
    generatedAt: new Date().toLocaleString(),
    projects: jobs.map(j => `${j.root || 'Repository root'} · ${j.adapter.language} · ${j.framework}`),
    filesWritten: files.filter(f => f.status === 'written').length,
    filesSkipped: files.filter(f => f.status === 'skipped').length,
    coverageBefore: before.summary,
    coverageAfter: after.summary,
    fileCoverage,
    coverageFiles: after.files.flatMap(f => (f.lines ? [f.lines] : [])),
    files,
    testCases,
    remaining: after.targets.map(({ job, target }) => joinRepo(job.root, target.rel)),
  };
}

// Finds the test names in a test file in the order they appear.
export function testCaseNames(text: string): string[] {
  const found: Array<{ index: number; name: string }> = [];
  for (const pattern of TEST_NAME_PATTERNS) {
    for (const m of text.matchAll(pattern)) {
      found.push({ index: m.index ?? 0, name: m[1].trim() });
    }
  }
  return found.sort((a, b) => a.index - b.index).map(f => f.name);
}


