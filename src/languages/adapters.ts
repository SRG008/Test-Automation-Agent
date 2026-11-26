import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { CommandResult, runCommand } from '../shell';
import { FileCoverage, Project } from '../types';
import { isTestPath, learnLayout, placeTest } from './conventions';
import { isSourceFile } from '../analysis';

// Paths are repo-relative with forward slashes, as printed by `git ls-files`.
export interface AdapterContext {
  repo: string;
  // Test framework the adapter installs and writes for. Empty for languages without a known framework.
  framework: string;
  // How the project's existing tests are written, from Copilot. Empty when there are none.
  styleNote?: string;
  files: string[];
}

export interface LanguageAdapter {
  language: string;
  // True for languages without a dedicated adapter. Their coverage is reported as not available.
  generic?: boolean;
  testRules(framework: string): string;
  isSource(rel: string): boolean;
  isTest(rel: string): boolean;
  listFunctions(source: string): string[];
  // Regex source that matches a test file's reference to an escaped function name. Defaults to a whole-word match.
  testRefPattern?(escapedName: string): string;
  testPathFor(rel: string, ctx: AdapterContext): string;
  // Returns an error message when the repo cannot be set up automatically.
  ensureTooling(ctx: AdapterContext): Promise<string | undefined>;
  // Runs the whole project's tests under a coverage tool. Undefined when that tool is not available for the framework.
  coverage?(ctx: AdapterContext): Promise<FileCoverage[] | undefined>;
}

export function dirOf(rel: string): string {
  const i = rel.lastIndexOf('/');
  return i < 0 ? '' : rel.slice(0, i);
}

const toPosix = (p: string): string => p.replace(/\\/g, '/');

// A scratch folder outside the repo, so coverage output never lands in the user's tree.
async function withScratch<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'autotest-cov-'));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

const baseOf = (rel: string): string => rel.slice(rel.lastIndexOf('/') + 1);
const stemOf = (rel: string): string => baseOf(rel).replace(/\.[^.]+$/, '');
const extOf = (rel: string): string => {
  const base = baseOf(rel);
  const i = base.lastIndexOf('.');
  return i < 0 ? '' : base.slice(i);
};
const joinRel = (dir: string, name: string): string => (dir ? `${dir}/${name}` : name);

function namesFrom(source: string, pattern: RegExp): string[] {
  return [...new Set([...source.matchAll(pattern)].map(m => m[1]))];
}

// The directory that holds most of the given files; used to follow an existing test layout.
function commonDir(files: string[]): string {
  const counts = new Map<string, number>();
  for (const f of files) {
    counts.set(dirOf(f), (counts.get(dirOf(f)) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '';
}

// The closest project file above a source file, e.g. the .csproj that owns it.
function nearestProject(rel: string, projects: string[]): string | undefined {
  let dir = dirOf(rel);
  for (;;) {
    const hit = projects.find(p => dirOf(p) === dir);
    if (hit || dir === '') return hit;
    dir = dirOf(dir);
  }
}

// ---------- Python (pytest / unittest) ----------

const isPythonTest = (rel: string): boolean => rel.endsWith('.py') && isTestPath(rel);
const isPythonSource = (rel: string): boolean =>
  rel.endsWith('.py') && !isPythonTest(rel) && baseOf(rel) !== 'conftest.py' && !/(^|\/)(venv|\.venv|build|dist)\//.test(rel);

// Prefers the project's own virtual environment so its dependencies are importable.
export async function pythonFor(repo: string): Promise<string> {
  const candidates = process.platform === 'win32' ? ['Scripts\\python.exe'] : ['bin/python'];
  for (const venv of ['.venv', 'venv']) {
    for (const rel of candidates) {
      const exe = path.join(repo, venv, rel);
      if (await fs.access(exe).then(() => true, () => false)) return exe;
    }
  }
  return 'python';
}

// Reads statement and missing-line counts for source files that no test loaded, using coverage.py's own analysis.
const UNEXECUTED_MARK = 'AUTOTEST_UNEXECUTED:';
const PY_ANALYZE = [
  'import json, sys',
  'import coverage',
  'cov = coverage.Coverage(data_file=sys.argv[1])',
  'cov.load()',
  'out = []',
  'for path in json.load(open(sys.argv[2], encoding="utf-8")):',
  '    try:',
  '        _, statements, _, missing, _ = cov.analysis2(path)',
  '        out.append({"statements": sorted(statements), "missing": sorted(missing)})',
  '    except Exception:',
  '        out.append(None)',
  `print("${UNEXECUTED_MARK}" + json.dumps(out))`,
].join('\n');

async function unexecutedPython(py: string, dir: string, repo: string, rels: string[]): Promise<FileCoverage[]> {
  if (rels.length === 0) return [];
  const script = path.join(dir, 'analyze.py');
  const list = path.join(dir, 'files.json');
  await fs.writeFile(script, PY_ANALYZE, 'utf8');
  await fs.writeFile(list, JSON.stringify(rels.map(rel => path.join(repo, rel))), 'utf8');
  const run = await runCommand(py, [script, path.join(dir, '.coverage'), list], repo, 300_000);
  const line = run.output.split('\n').find(l => l.includes(UNEXECUTED_MARK));
  if (run.code !== 0 || !line) return [];
  const found = JSON.parse(line.slice(line.indexOf(UNEXECUTED_MARK) + UNEXECUTED_MARK.length)) as
    | ({ statements: number[]; missing: number[] } | null)[];
  return rels.flatMap((rel, i): FileCoverage[] => {
    const f = found[i];
    if (!f) return [];
    const missing = new Set(f.missing);
    return [{ rel, executable: f.statements.length, covered: f.statements.filter(n => !missing.has(n)), uncovered: f.missing }];
  });
}

// Folders Python must put on its import path, found from the repo's own layout: a package's import root is
// the first ancestor folder without an __init__.py (for example "src" for src/pkg/mod.py). Flat repos give "".
async function pythonImportRoots(ctx: AdapterContext): Promise<string[]> {
  const roots = new Set<string>();
  for (const rel of ctx.files.filter(f => f.endsWith('.py'))) {
    const parts = rel.split('/').slice(0, -1);
    while (parts.length > 0 && (await fs.access(path.join(ctx.repo, ...parts, '__init__.py')).then(() => true, () => false))) {
      parts.pop();
    }
    roots.add(parts.join('/'));
  }
  return [...roots].sort();
}

// PYTHONPATH with the detected import roots first, so both test runs and coverage can import the project's modules.
export async function pythonEnv(ctx: AdapterContext): Promise<NodeJS.ProcessEnv> {
  const roots = (await pythonImportRoots(ctx)).map(r => path.join(ctx.repo, ...r.split('/').filter(Boolean)));
  const existing = process.env.PYTHONPATH ? [process.env.PYTHONPATH] : [];
  return { PYTHONPATH: [...roots, ...existing].join(path.delimiter) };
}

const python: LanguageAdapter = {
  language: 'Python',
  testRules: framework =>
    framework === 'unittest'
      ? 'Import the module under test using its package path. Use unittest.TestCase classes.'
      : 'Import the module under test using its package path. Use plain pytest functions (def test_...) and pytest fixtures.',
  isSource: isPythonSource,
  isTest: isPythonTest,
  listFunctions: src => namesFrom(src, /^[ \t]*(?:async[ \t]+)?def[ \t]+([A-Za-z]\w*)[ \t]*\(/gm),
  testPathFor(rel, ctx) {
    const layout = learnLayout(ctx.files.filter(isPythonSource), ctx.files.filter(isPythonTest));
    return placeTest(rel, layout, { dir: () => 'tests', prefix: 'test_', suffix: '' });
  },
  async ensureTooling(ctx) {
    const py = await pythonFor(ctx.repo);
    if ((await runCommand(py, ['--version'], ctx.repo)).code !== 0) {
      return 'Python was not found. Install Python 3 from https://www.python.org/downloads/, restart VS Code, then click Recheck.';
    }
    const missing: string[] = [];
    if (ctx.framework !== 'unittest' && (await runCommand(py, ['-m', 'pytest', '--version'], ctx.repo)).code !== 0) missing.push('pytest');
    if ((await runCommand(py, ['-m', 'coverage', '--version'], ctx.repo)).code !== 0) missing.push('coverage');
    if (missing.length === 0) return undefined;
    const install = await runCommand(py, ['-m', 'pip', 'install', ...missing], ctx.repo);
    if (install.code === 0) return undefined;
    return installFailure(
      missing.join(', '),
      install.output,
      `run "${py}" -m pip install ${missing.join(' ')} in the repository and read the error it prints. If pip is missing, run "${py}" -m ensurepip --upgrade. Check network or proxy access to PyPI, then click Start again.`,
    );
  },
  async coverage(ctx) {
    const py = await pythonFor(ctx.repo);
    return withScratch(async dir => {
      const env = { ...(await pythonEnv(ctx)), COVERAGE_FILE: path.join(dir, '.coverage') };
      const testArgs = ctx.framework === 'unittest' ? ['unittest', 'discover'] : ['pytest', '-q'];
      // Failing tests still leave coverage data behind, so the run's exit code is not checked here.
      await runCommand(py, ['-m', 'coverage', 'run', '--branch', '--source=.', '-m', ...testArgs], ctx.repo, 600_000, env);
      const out = path.join(dir, 'coverage.json');
      const report = await runCommand(py, ['-m', 'coverage', 'json', '-o', out], ctx.repo, 300_000, env);
      if (report.code !== 0) throw new Error(`Could not read Python coverage:\n${report.output}`);
      const data = JSON.parse(await fs.readFile(out, 'utf8')) as {
        files: Record<
          string,
          {
            executed_lines: number[];
            missing_lines: number[];
            summary: { num_statements: number; num_branches?: number; covered_branches?: number };
          }
        >;
      };
      const measured = Object.entries(data.files).map(([file, f]) => ({
        // coverage.py reports absolute paths when --source is used, so they are made repo-relative.
        rel: toPosix(path.isAbsolute(file) ? path.relative(ctx.repo, file) : file),
        executable: f.summary.num_statements,
        covered: f.executed_lines,
        uncovered: f.missing_lines,
        // coverage.py has no method counts, so methods stay unmeasured for Python.
        branches:
          f.summary.num_branches === undefined
            ? undefined
            : { covered: f.summary.covered_branches ?? 0, total: f.summary.num_branches },
      }));
      const seen = new Set(measured.map(m => m.rel));
      const unseen = ctx.files.filter(f => python.isSource(f) && !seen.has(f));
      return [...measured, ...(await unexecutedPython(py, dir, ctx.repo, unseen))];
    });
  },
};


// ---------- TypeScript / JavaScript (Vitest, Jest, Mocha) ----------

const TS_FILE = /\.(ts|tsx|js|jsx|mjs|cjs)$/;
const isTsTest = (rel: string): boolean => TS_FILE.test(rel) && isTestPath(rel);
const isTsSource = (rel: string): boolean =>
  TS_FILE.test(rel) &&
  !isTsTest(rel) &&
  !/\.d\.ts$/.test(rel) &&
  !/\.config\.[^/]+$/.test(baseOf(rel)) &&
  !/(^|\/)(node_modules|dist|build|out|coverage)\//.test(rel);

export const TS_TOOLS: Record<string, string> = { Vitest: 'vitest', Jest: 'jest', Mocha: 'mocha' };

// Runners the project already sets up itself (e.g. Angular CLI's Karma + Jasmine), so no package is added. Their tests run through the project's test command.
const TS_OWN_RUNNERS = ['Jasmine'];

// Packages a TypeScript project needs on top of the framework, so its test files compile and run.
const TS_EXTRAS: Record<string, string[]> = {
  Jest: ['ts-jest', '@types/jest'],
  Mocha: ['ts-node', '@types/mocha'],
};

const isTsFile = (rel: string): boolean => /\.tsx?$/.test(rel);

// Installs dev dependencies. npm can refuse a tool over an optional peer conflict (e.g. @types/node
// versions), so it retries with --legacy-peer-deps, which only skips peer checks for these installs.
async function npmInstallDev(repo: string, packages: string[]): Promise<CommandResult> {
  const first = await runCommand('npm', ['install', '-D', ...packages], repo, 600_000);
  if (first.code === 0 || !first.output.includes('ERESOLVE')) return first;
  return runCommand('npm', ['install', '-D', '--legacy-peer-deps', ...packages], repo, 600_000);
}

// The message shown when an install fails: the error lines from the tool, then the steps to fix it.
function installFailure(what: string, output: string, fix: string): string {
  const errors = output
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => /error|failed|not found|denied|unable/i.test(line))
    .slice(0, 4);
  const detail = errors.length > 0 ? errors.join('\n') : output.trim().slice(-600);
  return `Could not install ${what}.\n${detail}\nHow to fix: ${fix}`;
}

// Without node_modules, every test run fails before any test starts, so install the project's own dependencies first.
async function ensureNodeModules(ctx: AdapterContext): Promise<string | undefined> {
  const installed = await fs.access(path.join(ctx.repo, 'node_modules')).then(
    () => true,
    () => false,
  );
  if (installed) return undefined;
  const command = ctx.files.includes('package-lock.json') ? ['ci'] : ['install'];
  const result = await runCommand('npm', command, ctx.repo, 600_000);
  if (result.code === 0) return undefined;
  return installFailure(
    'the project dependencies',
    result.output,
    `run "npm ${command.join(' ')}" in the repository and fix the error it prints, then click Start again.`,
  );
}

// Projects often generate their environment files from .env before running tests. Start from the placeholder
// example when there is no .env, so the test script runs. Tests use mock data, so no real values are needed.
async function ensureEnvFile(ctx: AdapterContext): Promise<void> {
  if (!ctx.files.includes('.env.example') || ctx.files.includes('.env')) return;
  await fs.copyFile(path.join(ctx.repo, '.env.example'), path.join(ctx.repo, '.env'));
  ctx.files.push('.env');
}

// ts-jest is the transform for TypeScript tests, so write a config for it when the repo has none.
async function ensureJestConfig(ctx: AdapterContext, pkg: { type?: string; jest?: unknown }): Promise<void> {
  if (pkg.jest !== undefined || ctx.files.some(f => /^jest\.config\.[cm]?[jt]s$/.test(f))) return;
  const body = pkg.type === 'module' ? "export default { preset: 'ts-jest' };\n" : "module.exports = { preset: 'ts-jest' };\n";
  await fs.writeFile(path.join(ctx.repo, 'jest.config.js'), body, 'utf8');
  ctx.files.push('jest.config.js');
}

const typescript: LanguageAdapter = {
  language: 'TypeScript/JavaScript',
  testRules: framework => {
    const api =
      framework === 'Jest'
        ? 'Use the Jest globals (describe, test, expect) and jest.mock for mocks.'
        : framework === 'Mocha'
          ? 'Use Mocha (describe and it) with the Node assert module.'
          : framework === 'Jasmine'
            ? 'Use the Jasmine globals (describe, it, expect) and jasmine.createSpyObj for mocks. For Angular, use TestBed with HttpClientTestingModule or stub providers, and never call real HTTP, the real environment files or real storage.'
            : 'Use Vitest (import { describe, it, expect, vi } from "vitest").';
    const mocks = framework === 'Jasmine' ? 'Use inline mock data in every test; it must not depend on a backend or .env values.' : '';
    return `${api} ${mocks} Import the code under test from its module path relative to the test file. Mock network, clock and file system access so tests are deterministic. Every test must pass.`;
  },
  isSource: isTsSource,
  isTest: isTsTest,
  listFunctions: src =>
    [
      ...namesFrom(src, /export[ \t]+(?:default[ \t]+)?(?:async[ \t]+)?function\*?[ \t]+([A-Za-z_$][\w$]*)/g),
      ...namesFrom(
        src,
        /export[ \t]+const[ \t]+([A-Za-z_$][\w$]*)[ \t]*(?::[^=\n]+)?=[ \t]*(?:async[ \t]+)?(?:\([^)]*\)(?:[ \t]*:[^=\n]+)?|[A-Za-z_$][\w$]*)[ \t]*=>/g,
      ),
      ...namesFrom(src, /export[ \t]+(?:default[ \t]+)?(?:abstract[ \t]+)?class[ \t]+([A-Za-z_$][\w$]*)/g),
    ].filter((name, i, all) => all.indexOf(name) === i),
  testPathFor(rel, ctx) {
    const layout = learnLayout(ctx.files.filter(isTsSource), ctx.files.filter(isTsTest));
    return placeTest(rel, layout, { dir: () => 'tests', prefix: '', suffix: '.test' });
  },
  async ensureTooling(ctx) {
    if (!ctx.files.includes('package.json')) return 'No package.json found at the repository root.';
    const pkg = JSON.parse(await fs.readFile(path.join(ctx.repo, 'package.json'), 'utf8')) as {
      type?: string;
      jest?: unknown;
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    const tool = TS_TOOLS[ctx.framework];
    if (!tool && !TS_OWN_RUNNERS.includes(ctx.framework)) return `${ctx.framework} is not supported for TypeScript/JavaScript yet.`;
    const bootstrapError = await ensureNodeModules(ctx);
    if (bootstrapError) return bootstrapError;
    await ensureEnvFile(ctx);
    if (!tool) return undefined;
    const isTs = ctx.files.some(isTsFile);
    const missing = [tool, ...(isTs ? TS_EXTRAS[ctx.framework] ?? [] : [])].filter(p => !(p in deps));
    if (missing.length > 0) {
      const install = await npmInstallDev(ctx.repo, missing);
      if (install.code !== 0) {
        return installFailure(
          missing.join(', '),
          install.output,
          `run "npm install -D ${missing.join(' ')}" in the repository and fix the error it prints. Use Node.js 18 or newer, and check access to the npm registry. If the error is about conflicting versions in package.json, align the versions it names and click Start again.`,
        );
      }
    }
    if (ctx.framework === 'Jest' && isTs) await ensureJestConfig(ctx, pkg);
    // The v8 provider must match the installed Vitest version, so read it after the install above.
    const installed = JSON.parse(await fs.readFile(path.join(ctx.repo, 'package.json'), 'utf8')) as typeof pkg;
    const allDeps = { ...installed.dependencies, ...installed.devDependencies };
    if (ctx.framework === 'Vitest' && !('@vitest/coverage-v8' in allDeps)) {
      const version = allDeps.vitest?.replace(/^[\^~>=<\s]+/, '');
      const spec = version && /^\d/.test(version) ? `@vitest/coverage-v8@${version}` : '@vitest/coverage-v8';
      const install = await npmInstallDev(ctx.repo, [spec]);
      if (install.code !== 0) {
        return installFailure(
          '@vitest/coverage-v8',
          install.output,
          `run "npm install -D ${spec}" in the repository and fix the error it prints, then click Start again.`,
        );
      }
    }
    return undefined;
  },
  async coverage(ctx) {
    if (ctx.framework !== 'Jest' && ctx.framework !== 'Vitest') return undefined;
    return withScratch(async dir => {
      // Both tools write Istanbul-format coverage-final.json when asked for the json reporter.
      const run =
        ctx.framework === 'Jest'
          ? await runCommand(
              'npx',
              ['jest', '--coverage', '--coverageReporters=json', `--coverageDirectory=${dir}`, '--collectCoverageFrom=**/*.{ts,tsx,js,jsx}'],
              ctx.repo,
              600_000,
            )
          : await runCommand(
              'npx',
              ['vitest', 'run', '--coverage.enabled', '--coverage.provider=v8', '--coverage.reporter=json', `--coverage.reportsDirectory=${dir}`],
              ctx.repo,
              600_000,
            );
      const text = await fs.readFile(path.join(dir, 'coverage-final.json'), 'utf8').catch(() => undefined);
      if (text === undefined) throw new Error(`${ctx.framework} did not write a coverage report:\n${run.output}`);
      return istanbulFiles(ctx.repo, JSON.parse(text) as Record<string, IstanbulFile>);
    });
  },
};

interface IstanbulFile {
  path?: string;
  statementMap: Record<string, { start: { line: number } }>;
  s: Record<string, number>;
  // Branch hit counts per branch id, and function hit counts per function id. Absent in some reporters.
  b?: Record<string, number[]>;
  f?: Record<string, number>;
}

// A line counts as covered when any statement that starts on it ran.
function istanbulFiles(repo: string, data: Record<string, IstanbulFile>): FileCoverage[] {
  return Object.entries(data).map(([key, file]) => {
    const covered = new Map<number, boolean>();
    for (const [id, loc] of Object.entries(file.statementMap)) {
      const line = loc.start.line;
      covered.set(line, (covered.get(line) ?? false) || file.s[id] > 0);
    }
    const branchHits = Object.values(file.b ?? {}).flat();
    const fnHits = Object.values(file.f ?? {});
    return {
      rel: toPosix(path.relative(repo, file.path ?? key)),
      executable: covered.size,
      covered: [...covered].filter(([, hit]) => hit).map(([line]) => line).sort((a, b) => a - b),
      uncovered: [...covered].filter(([, hit]) => !hit).map(([line]) => line).sort((a, b) => a - b),
      branches: file.b ? { covered: branchHits.filter(n => n > 0).length, total: branchHits.length } : undefined,
      methods: file.f ? { covered: fnHits.filter(n => n > 0).length, total: fnHits.length } : undefined,
    };
  });
}



// ---------- Go (go test) ----------

const go: LanguageAdapter = {
  language: 'Go',
  testRules: () =>
    'Use the standard testing package. The test file must use the same package name as the code under test (or the _test suffix). Prefer table-driven tests with t.Run.',
  isSource: rel => rel.endsWith('.go') && !rel.endsWith('_test.go') && !/(^|\/)vendor\//.test(rel),
  isTest: rel => rel.endsWith('_test.go'),
  listFunctions: src => namesFrom(src, /^func[ \t]+(?:\([^)]*\)[ \t]*)?([A-Z]\w*)[ \t]*\(/gm),
  // Go tests are named TestXxx, so either the bare call or the Test-prefixed name counts.
  testRefPattern: esc => `(?<![\\w$])(?:${esc}|Test${esc})(?![a-z0-9])`,
  testPathFor: rel => joinRel(dirOf(rel), `${stemOf(rel)}_test.go`),
  async ensureTooling(ctx) {
    if (!ctx.files.includes('go.mod')) return 'No go.mod found at the repository root.';
    return (await runCommand('go', ['version'], ctx.repo)).code === 0
      ? undefined
      : 'Go was not found. Install Go from https://go.dev/dl/, restart VS Code, then click Recheck.';
  },
  async coverage(ctx) {
    const modText = await fs.readFile(path.join(ctx.repo, 'go.mod'), 'utf8').catch(() => '');
    const modulePath = /^module\s+(\S+)/m.exec(modText)?.[1] ?? '';
    return withScratch(async dir => {
      const profile = path.join(dir, 'cover.out');
      const run = await runCommand('go', ['test', '-coverpkg=./...', `-coverprofile=${profile}`, './...'], ctx.repo, 600_000);
      const text = await fs.readFile(profile, 'utf8').catch(() => undefined);
      if (text === undefined) throw new Error(`go test did not write a coverage profile:\n${run.output}`);
      return goProfileFiles(text, modulePath);
    });
  },
};

// Profile lines look like: example.com/mod/pkg/file.go:12.2,14.9 3 0
function goProfileFiles(text: string, modulePath: string): FileCoverage[] {
  const files = new Map<string, Map<number, boolean>>();
  for (const m of text.matchAll(/^(.+):(\d+)\.\d+,(\d+)\.\d+ \d+ (\d+)$/gm)) {
    const rel = modulePath && m[1].startsWith(`${modulePath}/`) ? m[1].slice(modulePath.length + 1) : m[1];
    const lines = files.get(rel) ?? new Map<number, boolean>();
    for (let line = Number(m[2]); line <= Number(m[3]); line++) {
      lines.set(line, (lines.get(line) ?? false) || Number(m[4]) > 0);
    }
    files.set(rel, lines);
  }
  return [...files].map(([rel, lines]) => ({
    rel,
    executable: lines.size,
    covered: [...lines].filter(([, hit]) => hit).map(([line]) => line).sort((a, b) => a - b),
    uncovered: [...lines].filter(([, hit]) => !hit).map(([line]) => line).sort((a, b) => a - b),
  }));
}


// ---------- Java (JUnit 5 with Maven or Gradle) ----------

// Coordinates for each Java framework's test dependency and the Gradle test-task setting it needs.
const JAVA_FRAMEWORK: Record<string, { maven: string; gradle: string; gradleTask: string; probe: RegExp }> = {
  'JUnit 5': {
    maven: '<dependency><groupId>org.junit.jupiter</groupId><artifactId>junit-jupiter</artifactId><version>5.10.2</version><scope>test</scope></dependency>',
    gradle: 'org.junit.jupiter:junit-jupiter:5.10.2',
    gradleTask: 'useJUnitPlatform()',
    probe: /junit-jupiter/,
  },
  TestNG: {
    maven: '<dependency><groupId>org.testng</groupId><artifactId>testng</artifactId><version>7.10.2</version><scope>test</scope></dependency>',
    gradle: 'org.testng:testng:7.10.2',
    gradleTask: 'useTestNG()',
    probe: /testng/i,
  },
};

// Character ranges covered by the given XML tags, so edits can skip nested blocks.
function tagRanges(xml: string, tags: string[]): [number, number][] {
  const pattern = new RegExp(`<(${tags.join('|')})>[\\s\\S]*?<\\/\\1>`, 'g');
  return [...xml.matchAll(pattern)].map(m => [m.index ?? 0, (m.index ?? 0) + m[0].length]);
}

const inRanges = (ranges: [number, number][], i: number): boolean => ranges.some(([start, end]) => i >= start && i < end);

// Adds the dependency to the top-level <dependencies> block, skipping the ones inside dependencyManagement, build, profiles and reporting.
function addMavenDependency(pom: string, dep: string): string {
  const skipped = tagRanges(pom, ['dependencyManagement', 'build', 'profiles', 'reporting']);
  const closer = [...pom.matchAll(/<\/dependencies>/g)]
    .map(m => m.index ?? 0)
    .find(i => !inRanges(skipped, i));
  if (closer !== undefined) return `${pom.slice(0, closer)}    ${dep}\n  ${pom.slice(closer)}`;
  const end = pom.lastIndexOf('</project>');
  if (end < 0) throw new Error('pom.xml has no </project> element.');
  return `${pom.slice(0, end)}  <dependencies>\n    ${dep}\n  </dependencies>\n${pom.slice(end)}`;
}

function addGradleDependency(build: string, framework: string, kotlin: boolean): string {
  const entry = JAVA_FRAMEWORK[framework];
  const dep = kotlin ? `testImplementation("${entry.gradle}")` : `testImplementation '${entry.gradle}'`;
  const task = kotlin ? `tasks.test {\n    ${entry.gradleTask}\n}` : `test {\n    ${entry.gradleTask}\n}`;
  return `${build}\ndependencies {\n    ${dep}\n}\n\n${task}\n`;
}

const JACOCO_VERSION = '0.8.12';

// Adds JaCoCo to the top-level build plugins: prepare-agent instruments the tests and report runs after them.
function addMavenJacoco(pom: string): string {
  const plugin = `<plugin><groupId>org.jacoco</groupId><artifactId>jacoco-maven-plugin</artifactId><version>${JACOCO_VERSION}</version><executions><execution><id>prepare-agent</id><goals><goal>prepare-agent</goal></goals></execution><execution><id>report</id><phase>test</phase><goals><goal>report</goal></goals></execution></executions></plugin>`;
  const skipped = tagRanges(pom, ['profiles', 'reporting']);
  const build = [...pom.matchAll(/<build>([\s\S]*?)<\/build>/g)].find(m => !inRanges(skipped, m.index ?? 0));
  if (!build) {
    const end = pom.lastIndexOf('</project>');
    if (end < 0) throw new Error('pom.xml has no </project> element.');
    return `${pom.slice(0, end)}  <build>\n    <plugins>${plugin}</plugins>\n  </build>\n${pom.slice(end)}`;
  }
  const start = build.index ?? 0;
  const bodyStart = start + '<build>'.length;
  const managed = tagRanges(build[1], ['pluginManagement']);
  const close = [...build[1].matchAll(/<\/plugins>/g)].map(m => m.index ?? 0).find(i => !inRanges(managed, i));
  if (close !== undefined) {
    const at = bodyStart + close;
    return `${pom.slice(0, at)}${plugin}${pom.slice(at)}`;
  }
  const at = start + build[0].length - '</build>'.length;
  return `${pom.slice(0, at)}<plugins>${plugin}</plugins>\n  ${pom.slice(at)}`;
}

// Gradle init script: applies JaCoCo to each Java project and writes its XML report to the folder in AUTOTEST_COV. Failing tests don't stop the report.
const GRADLE_JACOCO_INIT = `allprojects {
  plugins.withId('java') {
    apply plugin: 'jacoco'
    tasks.withType(Test).configureEach {
      ignoreFailures = true
    }
    tasks.withType(JacocoReport).configureEach {
      reports {
        xml.required = true
        html.required = false
        csv.required = false
      }
      reports.xml.outputLocation = file(System.getenv('AUTOTEST_COV') + '/' + project.path.replace(':', '_') + '.xml')
    }
  }
}
`;

// The repo's wrapper when it has one, otherwise the tool on PATH.
function buildTool(ctx: AdapterContext, wrapper: string, tool: string): string {
  if (!ctx.files.includes(wrapper)) return tool;
  return process.platform === 'win32' ? wrapper : `./${wrapper}`;
}

const fileExists = (p: string): Promise<boolean> => fs.access(p).then(() => true, () => false);

interface JavaLine { mi: number; ci: number; cb: number; mb: number }
interface JavaFileData { lines: Map<number, JavaLine>; methods: Map<string, boolean> }

const xmlAttr = (attrs: string, name: string): string | undefined => new RegExp(`\\b${name}="([^"]*)"`).exec(attrs)?.[1];

// Reads one JaCoCo XML report into the per-file data. JaCoCo names files by package path, so each one is matched to
// the repo file that ends with that path.
function readJacoco(xml: string, ctx: AdapterContext, files: Map<string, JavaFileData>): void {
  const dataFor = (rel: string): JavaFileData => {
    let data = files.get(rel);
    if (!data) {
      data = { lines: new Map(), methods: new Map() };
      files.set(rel, data);
    }
    return data;
  };
  for (const pkg of xml.matchAll(/<package\b([^>]*)(?<!\/)>([\s\S]*?)<\/package>/g)) {
    const pkgName = xmlAttr(pkg[1], 'name') ?? '';
    const relOf = (file: string): string | undefined => {
      const key = pkgName ? `${pkgName}/${file}` : file;
      return ctx.files.find(f => isJavaSource(f) && (f === key || f.endsWith(`/${key}`)));
    };
    for (const src of pkg[2].matchAll(/<sourcefile\b([^>]*)(?<!\/)>([\s\S]*?)<\/sourcefile>/g)) {
      const rel = relOf(xmlAttr(src[1], 'name') ?? '');
      if (!rel) continue;
      const lines = dataFor(rel).lines;
      for (const tag of src[2].matchAll(/<line\b([^>]*)>/g)) {
        const a = tag[1];
        lines.set(Number(xmlAttr(a, 'nr')), {
          mi: Number(xmlAttr(a, 'mi')),
          ci: Number(xmlAttr(a, 'ci')),
          cb: Number(xmlAttr(a, 'cb')),
          mb: Number(xmlAttr(a, 'mb')),
        });
      }
    }
    for (const cls of pkg[2].matchAll(/<class\b([^>]*)(?<!\/)>([\s\S]*?)<\/class>/g)) {
      const rel = relOf(xmlAttr(cls[1], 'sourcefilename') ?? '');
      if (!rel) continue;
      const methods = dataFor(rel).methods;
      const className = xmlAttr(cls[1], 'name') ?? '';
      for (const m of cls[2].matchAll(/<method\b([^>]*)>([\s\S]*?)<\/method>/g)) {
        const key = `${className}|${xmlAttr(m[1], 'name') ?? ''}${xmlAttr(m[1], 'desc') ?? ''}`;
        const lineCounter = /<counter type="LINE" missed="\d+" covered="(\d+)"/.exec(m[2]);
        methods.set(key, (methods.get(key) ?? false) || Number(lineCounter?.[1] ?? 0) > 0);
      }
    }
  }
}

function javaFileCoverage(files: Map<string, JavaFileData>): FileCoverage[] {
  const sorted = (lines: number[]): number[] => lines.sort((a, b) => a - b);
  return [...files]
    .filter(([, data]) => data.lines.size > 0)
    .map(([rel, data]) => {
      const executable = [...data.lines].filter(([, l]) => l.mi + l.ci > 0);
      const lines = [...data.lines.values()];
      const methodHits = [...data.methods.values()];
      return {
        rel,
        executable: executable.length,
        covered: sorted(executable.filter(([, l]) => l.ci > 0).map(([n]) => n)),
        uncovered: sorted(executable.filter(([, l]) => l.ci === 0).map(([n]) => n)),
        branches: { covered: lines.reduce((sum, l) => sum + l.cb, 0), total: lines.reduce((sum, l) => sum + l.cb + l.mb, 0) },
        methods: { covered: methodHits.filter(Boolean).length, total: methodHits.length },
      };
    });
}

const isJavaTest = (rel: string): boolean => rel.endsWith('.java') && isTestPath(rel);
const isJavaSource = (rel: string): boolean =>
  rel.endsWith('.java') && !isJavaTest(rel) && !/(^|\/)(module|package)-info\.java$/.test(rel);

const java: LanguageAdapter = {
  language: 'Java',
  testRules: framework =>
    framework === 'TestNG'
      ? 'Use TestNG (org.testng.annotations.Test and org.testng.Assert). Put the test class in the same package as the class under test, and name it after that class with a Test suffix.'
      : 'Use JUnit 5 (org.junit.jupiter.api.Test and Assertions). Put the test class in the same package as the class under test, and name it after that class with a Test suffix.',
  isSource: isJavaSource,
  isTest: isJavaTest,
  listFunctions: src => namesFrom(src, /^[ \t]*public[ \t]+(?:(?:static|final|synchronized|abstract)[ \t]+)*[\w<>\[\],.? ]+?[ \t]+([a-z]\w*)[ \t]*\(/gm),
  testPathFor(rel, ctx) {
    const layout = learnLayout(ctx.files.filter(isJavaSource), ctx.files.filter(isJavaTest));
    // Without existing tests, mirror a Maven/Gradle "main" folder as "test"; otherwise keep the source folder.
    const standard = { dir: (dir: string) => dir.replace(/(^|\/)main(?=\/)/, '$1test'), prefix: '', suffix: 'Test' };
    return placeTest(rel, layout, standard);
  },

  async ensureTooling(ctx) {
    const build = ctx.files.find(f => ['pom.xml', 'build.gradle', 'build.gradle.kts'].includes(f));
    if (!build) return 'No pom.xml or build.gradle found. Add a Maven or Gradle build first.';
    const entry = JAVA_FRAMEWORK[ctx.framework];
    if (!entry) return `${ctx.framework} is not supported for Java yet.`;
    const text = await fs.readFile(path.join(ctx.repo, build), 'utf8');
    let updated = text;
    if (!entry.probe.test(updated)) {
      updated =
        build === 'pom.xml'
          ? addMavenDependency(updated, entry.maven)
          : addGradleDependency(updated, ctx.framework, build.endsWith('.kts'));
    }
    if (build === 'pom.xml' && !updated.includes('jacoco-maven-plugin')) updated = addMavenJacoco(updated);
    if (updated !== text) await fs.writeFile(path.join(ctx.repo, build), updated, 'utf8');
    return undefined;
  },
  async coverage(ctx) {
    const files = new Map<string, JavaFileData>();
    const maven = ctx.files.includes('pom.xml');
    await withScratch(async dir => {
      let run: CommandResult;
      let reports: string[] = [];
      if (maven) {
        const poms = ctx.files.filter(f => baseOf(f) === 'pom.xml');
        const outDirs = poms.map(p => path.join(ctx.repo, dirOf(p), 'target', 'site', 'jacoco'));
        // Remove old reports first, so a build that fails before writing new ones can't be read as current.
        await Promise.all(outDirs.map(d => fs.rm(d, { recursive: true, force: true })));
        run = await runCommand(buildTool(ctx, 'mvnw', 'mvn'), ['-Dmaven.test.failure.ignore=true', 'test'], ctx.repo, 600_000);
        for (const d of outDirs) {
          const report = path.join(d, 'jacoco.xml');
          if (await fileExists(report)) reports.push(report);
        }
      } else {
        const init = path.join(dir, 'jacoco-init.gradle');
        await fs.writeFile(init, GRADLE_JACOCO_INIT, 'utf8');
        const script = process.platform === 'win32' ? `"${init}"` : init;
        run = await runCommand(
          buildTool(ctx, 'gradlew', 'gradle'),
          ['test', 'jacocoTestReport', '--continue', '--init-script', script],
          ctx.repo,
          600_000,
          { AUTOTEST_COV: dir },
        );
        reports = (await fs.readdir(dir)).filter(f => f.endsWith('.xml')).map(f => path.join(dir, f));
      }
      if (reports.length === 0) throw new Error(`The build wrote no JaCoCo report:\n${run.output}`);
      for (const report of reports) readJacoco(await fs.readFile(report, 'utf8'), ctx, files);
    });
    return javaFileCoverage(files);
  },
};

// ---------- C# (xUnit, NUnit, MSTest) ----------

// dotnet template and NuGet packages for each framework. The first package is the one that identifies the framework.
const CS_TEMPLATE: Record<string, string> = { xUnit: 'xunit', NUnit: 'nunit', MSTest: 'mstest' };
const CS_PACKAGES: Record<string, string[]> = {
  xUnit: ['xunit', 'xunit.runner.visualstudio', 'Microsoft.NET.Test.Sdk'],
  NUnit: ['NUnit', 'NUnit3TestAdapter', 'Microsoft.NET.Test.Sdk'],
  MSTest: ['MSTest.TestFramework', 'MSTest.TestAdapter', 'Microsoft.NET.Test.Sdk'],
};

const isCsTest = (rel: string): boolean => rel.endsWith('.cs') && /(^|\/)[^/]*tests?[^/]*\//i.test(rel);
const isCsTestProject = (rel: string): boolean => rel.endsWith('.csproj') && /test/i.test(baseOf(rel));
const csTestProject = (ctx: AdapterContext): string | undefined => ctx.files.find(isCsTestProject);

// Coverage needs coverlet.collector in every test project, so add it where it is missing.
async function ensureCoverlet(ctx: AdapterContext): Promise<string | undefined> {
  for (const proj of ctx.files.filter(isCsTestProject)) {
    const xml = await fs.readFile(path.join(ctx.repo, proj), 'utf8').catch(() => '');
    if (/coverlet\.collector/i.test(xml)) continue;
    const add = await runCommand('dotnet', ['add', proj, 'package', 'coverlet.collector'], ctx.repo, 600_000);
    if (add.code !== 0) {
      return installFailure(
        `coverlet.collector in ${proj}`,
        add.output,
        `run "dotnet add ${proj} package coverlet.collector" in the repository and read the error. Check that nuget.org (or your NuGet feed) is reachable with "dotnet nuget list source", then click Start again.`,
      );
    }
  }
  return undefined;
}

async function findFiles(dir: string, name: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { recursive: true });
  return entries.filter(e => baseOf(toPosix(e)) === name).map(e => path.join(dir, e));
}

// Cobertura file names are absolute or relative to the test project; both become repo-relative.
const csRel = (repo: string, file: string): string => toPosix(path.isAbsolute(file) ? path.relative(repo, file) : file);


// Where a new test project goes: a <Project>.Tests folder inside the source project's folder.
// The source project excludes that folder from compilation (see ensureTooling).
function plannedCsTestProject(ctx: AdapterContext): string | undefined {
  const src = ctx.files.find(f => f.endsWith('.csproj') && !isCsTestProject(f));
  if (!src) return undefined;
  const name = `${stemOf(src)}.Tests`;
  return joinRel(joinRel(dirOf(src), name), `${name}.csproj`);
}

const csharp: LanguageAdapter = {
  language: 'C#',
  testRules: framework =>
    framework === 'NUnit'
      ? 'Use NUnit: [Test] for single cases and [TestCase] for several inputs, with Assert.That. Add a using for the namespace of the code under test.'
      : framework === 'MSTest'
        ? 'Use MSTest: [TestMethod] for cases and [TestClass] on the class, with Assert. Add a using for the namespace of the code under test.'
        : 'Use xUnit: [Fact] for single cases and [Theory] with [InlineData] for several inputs. Add a using for the namespace of the code under test.',
  isSource: rel => rel.endsWith('.cs') && !isCsTest(rel) && !/(^|\/)(obj|bin)\//.test(rel),
  isTest: isCsTest,
  listFunctions: src =>
    namesFrom(src, /^[ \t]*public[ \t]+(?:(?:static|async|virtual|override|sealed|new)[ \t]+)*[\w<>\[\],.? ]+?[ \t]+([A-Z]\w*)[ \t]*\(/gm),
  testPathFor(rel, ctx) {
    const proj = csTestProject(ctx) ?? plannedCsTestProject(ctx);
    return joinRel(dirOf(proj ?? 'Tests.csproj'), `${stemOf(rel)}Tests.cs`);
  },
  async ensureTooling(ctx) {
    if ((await runCommand('dotnet', ['--version'], ctx.repo)).code !== 0) {
      return '.NET SDK was not found. Install it from https://dotnet.microsoft.com/download, restart VS Code, then click Recheck.';
    }
    const existing = csTestProject(ctx);
    if (existing) {
      // An empty test project gets the chosen framework's packages; a project that already uses one is left alone.
      const xml = await fs.readFile(path.join(ctx.repo, existing), 'utf8').catch(() => '');
      if (!xml.toLowerCase().includes(`include="${CS_PACKAGES[ctx.framework][0].toLowerCase()}"`)) {
        for (const pkg of CS_PACKAGES[ctx.framework]) {
          const add = await runCommand('dotnet', ['add', existing, 'package', pkg], ctx.repo, 600_000);
          if (add.code !== 0) {
            return installFailure(
              `${pkg} in ${existing}`,
              add.output,
              `run "dotnet add ${existing} package ${pkg}" in the repository and read the error. Check that nuget.org (or your NuGet feed) is reachable with "dotnet nuget list source", then click Start again.`,
            );
          }
        }
      }
      return ensureCoverlet(ctx);
    }
    const src = ctx.files.find(f => f.endsWith('.csproj') && !isCsTestProject(f));
    const planned = plannedCsTestProject(ctx);
    if (!src || !planned) return 'No .csproj found. Open a .NET project, then try again.';

    const dir = dirOf(planned);
    const name = stemOf(planned);
    const created = await runCommand('dotnet', ['new', CS_TEMPLATE[ctx.framework], '-n', name, '-o', dir || '.'], ctx.repo);
    if (created.code !== 0) {
      return installFailure(
        `the ${ctx.framework} test project`,
        created.output,
        `run "dotnet new list" to confirm the ${CS_TEMPLATE[ctx.framework]} template is available, and fix the error it prints. Then click Start again.`,
      );
    }
    await fs.rm(path.join(ctx.repo, dir, 'UnitTest1.cs'), { force: true });
    const linked = await runCommand('dotnet', ['add', planned, 'reference', src], ctx.repo);
    if (linked.code !== 0) {
      return installFailure(
        `the reference from ${planned} to ${src}`,
        linked.output,
        `run "dotnet add ${planned} reference ${src}" in the repository and fix the error it prints, then click Start again.`,
      );
    }

    const srcPath = path.join(ctx.repo, src);
    const srcXml = await fs.readFile(srcPath, 'utf8');
    if (srcXml.includes('</Project>')) {
      const exclude = `  <ItemGroup>\n    <Compile Remove="${name}/**" />\n  </ItemGroup>\n`;
      await fs.writeFile(srcPath, srcXml.replace('</Project>', `${exclude}</Project>`), 'utf8');
    }
    ctx.files.push(planned);
    return ensureCoverlet(ctx);
  },
  async coverage(ctx) {
    const projects = ctx.files.filter(isCsTestProject);
    if (projects.length === 0) throw new Error('No .NET test project found.');
    // Quoted on Windows because the shell would otherwise split the collector name at its space.
    const collect = process.platform === 'win32' ? '"--collect:XPlat Code Coverage"' : '--collect:XPlat Code Coverage';
    const lines = new Map<string, Map<number, boolean>>();
    // Per file: branch hits by line (highest seen wins, since reports can repeat a line) and method hits by name and signature.
    const branchHits = new Map<string, Map<number, [number, number]>>();
    const methodHits = new Map<string, Map<string, boolean>>();
    for (const proj of projects) {
      await withScratch(async dir => {
        const run = await runCommand('dotnet', ['test', proj, collect, '--results-directory', dir], ctx.repo, 600_000);
        const reports = await findFiles(dir, 'coverage.cobertura.xml');
        if (reports.length === 0) throw new Error(`dotnet test wrote no coverage report:\n${run.output}`);
        for (const report of reports) {
          const xml = await fs.readFile(report, 'utf8');
          for (const cls of xml.matchAll(/<class\b[^>]*\bfilename="([^"]+)"[^>]*>([\s\S]*?)<\/class>/g)) {
            const rel = csRel(ctx.repo, cls[1]);
            const covered = lines.get(rel) ?? new Map<number, boolean>();
            const branches = branchHits.get(rel) ?? new Map<number, [number, number]>();
            const methods = methodHits.get(rel) ?? new Map<string, boolean>();
            for (const tag of cls[2].matchAll(/<line\b[^>]*>/g)) {
              const number = Number(/\bnumber="(\d+)"/.exec(tag[0])?.[1]);
              const hits = Number(/\bhits="(\d+)"/.exec(tag[0])?.[1]);
              covered.set(number, (covered.get(number) ?? false) || hits > 0);
              const cond = /\bcondition-coverage="\d+% \((\d+)\/(\d+)\)"/.exec(tag[0]);
              if (cond) {
                const prev = branches.get(number);
                if (!prev || Number(cond[1]) > prev[0]) branches.set(number, [Number(cond[1]), Number(cond[2])]);
              }
            }
            for (const method of cls[2].matchAll(/<method\b([^>]*)>([\s\S]*?)<\/method>/g)) {
              const key = `${/\bname="([^"]+)"/.exec(method[1])?.[1] ?? ''}|${/\bsignature="([^"]*)"/.exec(method[1])?.[1] ?? ''}`;
              const hit = [...method[2].matchAll(/<line\b[^>]*\bhits="(\d+)"/g)].some(m => Number(m[1]) > 0);
              methods.set(key, (methods.get(key) ?? false) || hit);
            }
            lines.set(rel, covered);
            branchHits.set(rel, branches);
            methodHits.set(rel, methods);
          }
        }
      });
    }
    return [...lines].map(([rel, covered]) => {
      const branches = [...(branchHits.get(rel)?.values() ?? [])];
      const methods = [...(methodHits.get(rel)?.values() ?? [])];
      return {
        rel,
        executable: covered.size,
        covered: [...covered].filter(([, hit]) => hit).map(([line]) => line).sort((a, b) => a - b),
        uncovered: [...covered].filter(([, hit]) => !hit).map(([line]) => line).sort((a, b) => a - b),
        branches: { covered: branches.reduce((sum, [hit]) => sum + hit, 0), total: branches.reduce((sum, [, all]) => sum + all, 0) },
        methods: { covered: methods.filter(Boolean).length, total: methods.length },
      };
    });
  },
};


// Adapter for any language without a dedicated one. Source and test files come from the project's own lists (found by Copilot). Tests run through the repo's own test command, so no tooling is installed and coverage is not available.
function genericAdapter(project: Project): LanguageAdapter {
  // The project's lists are repo-relative, while adapters work with paths inside the project folder.
  const repoPath = (rel: string): string => (project.root ? `${project.root}/${rel}` : rel);
  const isTest = (rel: string): boolean => project.testFiles.includes(repoPath(rel));
  const isSource = (rel: string): boolean => isSourceFile(project, repoPath(rel));
  return {
    language: project.language,
    generic: true,
    testRules: () =>
      "Use the same test framework, naming, and assertion style as the existing test files in this project. Put every test in one self-contained test file that the project's test command runs.",
    isSource,
    isTest,
    listFunctions: () => [],
    testPathFor(rel, ctx) {
      const layout = learnLayout(ctx.files.filter(isSource), ctx.files.filter(isTest));
      return placeTest(rel, layout, { dir: sourceDir => joinRel('tests', sourceDir), prefix: '', suffix: '_test' });
    },
    async ensureTooling() {
      return undefined;
    },
  };
}

const ADAPTERS: Record<string, LanguageAdapter> = {
  Python: python,
  'TypeScript/JavaScript': typescript,
  Go: go,
  Java: java,
  'C#': csharp,
};

// The built-in adapter for the project's language when there is one, otherwise the generic adapter.
export function adapterFor(project: Project): LanguageAdapter {
  return ADAPTERS[project.language] ?? genericAdapter(project);
}

// The frameworks the built-in adapter can run for a language. Undefined for languages on the generic adapter.
function builtInFrameworks(language: string): string[] | undefined {
  switch (language) {
    case 'Python': return ['pytest', 'unittest'];
    case 'TypeScript/JavaScript': return [...Object.keys(TS_TOOLS), ...TS_OWN_RUNNERS];
    case 'Java': return Object.keys(JAVA_FRAMEWORK);
    case 'C#': return Object.keys(CS_TEMPLATE);
    default: return undefined;
  }
}

// Keeps only the frameworks the built-in adapter can run, spelled the way the adapter expects.
// A framework found in the tests that the adapter cannot run is dropped, along with its test command.
export function useSupportedFrameworks(project: Project): Project {
  const supported = builtInFrameworks(project.language);
  if (!supported) return project;
  const match = (name: string): string | undefined => supported.find(f => f.toLowerCase() === name.trim().toLowerCase());
  const framework = project.framework ? match(project.framework) : undefined;
  const frameworkOptions = [...new Set(project.frameworkOptions.map(match).filter((f): f is string => f !== undefined))];
  return { ...project, framework, frameworkOptions, testCommand: framework ? project.testCommand : undefined };
}
