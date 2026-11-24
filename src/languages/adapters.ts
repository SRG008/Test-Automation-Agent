import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { CommandResult, runCommand } from '../shell';
import { FileCoverage } from '../types';

// Paths are repo-relative with forward slashes, as printed by `git ls-files`.
export interface AdapterContext {
  repo: string;
  framework: string;
  files: string[];
}

export interface LanguageAdapter {
  language: string;
  testRules(framework: string): string;
  isSource(rel: string): boolean;
  isTest(rel: string): boolean;
  listFunctions(source: string): string[];
  // Regex source that matches a test file's reference to an escaped function name. Defaults to a whole-word match.
  testRefPattern?(escapedName: string): string;
  testPathFor(rel: string, ctx: AdapterContext): string;
  // Returns an error message when the repo cannot be set up automatically.
  ensureTooling(ctx: AdapterContext): Promise<string | undefined>;
  runTests(ctx: AdapterContext, testRel: string): Promise<CommandResult>;
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

const isPythonTest = (rel: string): boolean =>
  rel.endsWith('.py') && (/^test_/.test(baseOf(rel)) || /_test\.py$/.test(baseOf(rel)) || /(^|\/)tests?\//.test(rel));

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

const python: LanguageAdapter = {
  language: 'Python',
  testRules: framework =>
    framework === 'unittest'
      ? 'Import the module under test using its package path. Use unittest.TestCase classes.'
      : 'Import the module under test using its package path. Use plain pytest functions (def test_...) and pytest fixtures.',
  isSource: rel =>
    rel.endsWith('.py') && !isPythonTest(rel) && baseOf(rel) !== 'conftest.py' && !/(^|\/)(venv|\.venv|build|dist)\//.test(rel),
  isTest: isPythonTest,
  listFunctions: src => namesFrom(src, /^[ \t]*(?:async[ \t]+)?def[ \t]+([A-Za-z]\w*)[ \t]*\(/gm),
  testPathFor(rel, ctx) {
    const existing = ctx.files.filter(isPythonTest);
    const dir = existing.some(f => dirOf(f) === dirOf(rel)) ? dirOf(rel) : existing.length ? commonDir(existing) : 'tests';
    return joinRel(dir, `test_${stemOf(rel)}.py`);
  },
  async ensureTooling(ctx) {
    const py = await pythonFor(ctx.repo);
    if ((await runCommand(py, ['--version'], ctx.repo)).code !== 0) {
      return 'Python was not found on PATH. Install Python, then try again.';
    }
    const missing: string[] = [];
    if (ctx.framework !== 'unittest' && (await runCommand(py, ['-m', 'pytest', '--version'], ctx.repo)).code !== 0) missing.push('pytest');
    if ((await runCommand(py, ['-m', 'coverage', '--version'], ctx.repo)).code !== 0) missing.push('coverage');
    if (missing.length === 0) return undefined;
    const install = await runCommand(py, ['-m', 'pip', 'install', ...missing], ctx.repo);
    return install.code === 0 ? undefined : `Could not install ${missing.join(', ')}:\n${install.output}`;
  },
  async runTests(ctx, testRel) {
    const py = await pythonFor(ctx.repo);
    if (ctx.framework === 'unittest') {
      return runCommand(py, ['-m', 'unittest', 'discover', '-s', dirOf(testRel) || '.', '-p', baseOf(testRel)], ctx.repo);
    }
    return runCommand(py, ['-m', 'pytest', testRel, '-q'], ctx.repo);
  },
  async coverage(ctx) {
    const py = await pythonFor(ctx.repo);
    return withScratch(async dir => {
      const env = { COVERAGE_FILE: path.join(dir, '.coverage') };
      const testArgs = ctx.framework === 'unittest' ? ['unittest', 'discover'] : ['pytest', '-q'];
      // Failing tests still leave coverage data behind, so the run's exit code is not checked here.
      await runCommand(py, ['-m', 'coverage', 'run', '--source=.', '-m', ...testArgs], ctx.repo, 600_000, env);
      const out = path.join(dir, 'coverage.json');
      const report = await runCommand(py, ['-m', 'coverage', 'json', '-o', out], ctx.repo, 300_000, env);
      if (report.code !== 0) throw new Error(`Could not read Python coverage:\n${report.output}`);
      const data = JSON.parse(await fs.readFile(out, 'utf8')) as {
        files: Record<string, { missing_lines: number[]; summary: { num_statements: number } }>;
      };
      return Object.entries(data.files).map(([file, f]) => ({
        rel: toPosix(file),
        executable: f.summary.num_statements,
        uncovered: f.missing_lines,
      }));
    });
  },
};


// ---------- TypeScript / JavaScript (Vitest, Jest, Mocha) ----------

const TS_FILE = /\.(ts|tsx|js|jsx|mjs|cjs)$/;
const isTsTest = (rel: string): boolean =>
  TS_FILE.test(rel) && (/\.(test|spec)\.[^/]+$/.test(baseOf(rel)) || /(^|\/)(__tests__|tests?)\//.test(rel));

const TS_TOOLS: Record<string, string> = { Vitest: 'vitest', Jest: 'jest', Mocha: 'mocha' };

// Packages a TypeScript project needs on top of the framework, so its test files compile and run.
const TS_EXTRAS: Record<string, string[]> = {
  Jest: ['ts-jest', '@types/jest'],
  Mocha: ['ts-node', '@types/mocha'],
};

const isTsFile = (rel: string): boolean => /\.tsx?$/.test(rel);

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
          : 'Use Vitest (import { describe, it, expect, vi } from "vitest").';
    return `${api} Import the code under test from its module path relative to the test file. Mock network, clock and file system access so tests are deterministic.`;
  },
  isSource: rel =>
    TS_FILE.test(rel) &&
    !isTsTest(rel) &&
    !/\.d\.ts$/.test(rel) &&
    !/\.config\.[^/]+$/.test(baseOf(rel)) &&
    !/(^|\/)(node_modules|dist|build|out|coverage)\//.test(rel),
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
    const name = `${stemOf(rel)}.test${extOf(rel)}`;
    const existing = ctx.files.filter(isTsTest);
    if (existing.some(f => dirOf(f) === dirOf(rel))) return joinRel(dirOf(rel), name);
    const inTestsFolder = existing.filter(f => /(^|\/)__tests__\//.test(f));
    if (inTestsFolder.length) return joinRel(commonDir(inTestsFolder), name);
    if (existing.length) return joinRel(commonDir(existing), name);
    return joinRel('tests', name);
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
    if (!tool) return `${ctx.framework} is not supported for TypeScript/JavaScript yet.`;
    const isTs = ctx.files.some(isTsFile);
    const missing = [tool, ...(isTs ? TS_EXTRAS[ctx.framework] ?? [] : [])].filter(p => !(p in deps));
    if (missing.length > 0) {
      const install = await runCommand('npm', ['install', '-D', ...missing], ctx.repo, 600_000);
      if (install.code !== 0) return `Could not install ${missing.join(', ')}:\n${install.output}`;
    }
    if (ctx.framework === 'Jest' && isTs) await ensureJestConfig(ctx, pkg);
    // The v8 provider must match the installed Vitest version.
    if (ctx.framework === 'Vitest' && !('@vitest/coverage-v8' in deps)) {
      const version = deps.vitest?.replace(/^[\^~>=<\s]+/, '');
      const spec = version && /^\d/.test(version) ? `@vitest/coverage-v8@${version}` : '@vitest/coverage-v8';
      const install = await runCommand('npm', ['install', '-D', spec], ctx.repo, 600_000);
      if (install.code !== 0) return `Could not install @vitest/coverage-v8:\n${install.output}`;
    }
    return undefined;
  },
  runTests(ctx, testRel) {
    if (ctx.framework === 'Jest') return runCommand('npx', ['jest', testRel], ctx.repo);
    if (ctx.framework === 'Mocha') {
      const ts = isTsFile(testRel) ? ['--require', 'ts-node/register'] : [];
      return runCommand('npx', ['mocha', ...ts, testRel], ctx.repo);
    }
    return runCommand('npx', ['vitest', 'run', testRel], ctx.repo);
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
}

// A line counts as covered when any statement that starts on it ran.
function istanbulFiles(repo: string, data: Record<string, IstanbulFile>): FileCoverage[] {
  return Object.entries(data).map(([key, file]) => {
    const covered = new Map<number, boolean>();
    for (const [id, loc] of Object.entries(file.statementMap)) {
      const line = loc.start.line;
      covered.set(line, (covered.get(line) ?? false) || file.s[id] > 0);
    }
    return {
      rel: toPosix(path.relative(repo, file.path ?? key)),
      executable: covered.size,
      uncovered: [...covered].filter(([, hit]) => !hit).map(([line]) => line).sort((a, b) => a - b),
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
    return (await runCommand('go', ['version'], ctx.repo)).code === 0 ? undefined : 'Go was not found on PATH.';
  },
  runTests: (ctx, testRel) => runCommand('go', ['test', `./${dirOf(testRel)}`], ctx.repo),
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

// Adds the dependency to the top-level <dependencies> block, skipping the ones inside dependencyManagement, build, profiles and reporting.
function addMavenDependency(pom: string, dep: string): string {
  const skipped = [...pom.matchAll(/<(dependencyManagement|build|profiles|reporting)>[\s\S]*?<\/\1>/g)].map(m => [m.index ?? 0, (m.index ?? 0) + m[0].length]);
  const closer = [...pom.matchAll(/<\/dependencies>/g)]
    .map(m => m.index ?? 0)
    .find(i => !skipped.some(([start, end]) => i >= start && i < end));
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

const java: LanguageAdapter = {
  language: 'Java',
  testRules: framework =>
    framework === 'TestNG'
      ? 'Use TestNG (org.testng.annotations.Test and org.testng.Assert). Put the test class in the same package as the class under test, and name it after that class with a Test suffix.'
      : 'Use JUnit 5 (org.junit.jupiter.api.Test and Assertions). Put the test class in the same package as the class under test, and name it after that class with a Test suffix.',
  isSource: rel => /^src\/main\/java\/.+\.java$/.test(rel) && !rel.endsWith('module-info.java'),
  isTest: rel => /^src\/test\/java\/.+\.java$/.test(rel),
  listFunctions: src => namesFrom(src, /^[ \t]*public[ \t]+(?:(?:static|final|synchronized|abstract)[ \t]+)*[\w<>\[\],.? ]+?[ \t]+([a-z]\w*)[ \t]*\(/gm),
  testPathFor(rel) {
    const mapped = rel.replace(/^src\/main\/java\//, 'src/test/java/');
    return joinRel(dirOf(mapped), `${stemOf(rel)}Test.java`);
  },
  async ensureTooling(ctx) {
    const build = ctx.files.find(f => ['pom.xml', 'build.gradle', 'build.gradle.kts'].includes(f));
    if (!build) return 'No pom.xml or build.gradle found. Add a Maven or Gradle build first.';
    const entry = JAVA_FRAMEWORK[ctx.framework];
    if (!entry) return `${ctx.framework} is not supported for Java yet.`;
    const text = await fs.readFile(path.join(ctx.repo, build), 'utf8');
    if (entry.probe.test(text)) return undefined;
    const updated =
      build === 'pom.xml'
        ? addMavenDependency(text, entry.maven)
        : addGradleDependency(text, ctx.framework, build.endsWith('.kts'));
    await fs.writeFile(path.join(ctx.repo, build), updated, 'utf8');
    return undefined;
  },
  runTests(ctx, testRel) {
    const className = stemOf(testRel);
    if (ctx.files.includes('pom.xml')) {
      const mvnWrapper = process.platform === 'win32' ? 'mvnw' : './mvnw';
      const mvn = ctx.files.includes('mvnw') ? mvnWrapper : 'mvn';
      return runCommand(mvn, [`-Dtest=${className}`, 'test'], ctx.repo);
    }
    const wrapper = process.platform === 'win32' ? 'gradlew' : './gradlew';
    const gradle = ctx.files.includes('gradlew') ? wrapper : 'gradle';
    return runCommand(gradle, ['test', '--tests', className], ctx.repo);
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
    if (add.code !== 0) return `Could not add coverlet.collector to ${proj}:\n${add.output}`;
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
      return '.NET SDK was not found. Install it, then try again.';
    }
    const existing = csTestProject(ctx);
    if (existing) {
      // An empty test project gets the chosen framework's packages; a project that already uses one is left alone.
      const xml = await fs.readFile(path.join(ctx.repo, existing), 'utf8').catch(() => '');
      if (!xml.toLowerCase().includes(`include="${CS_PACKAGES[ctx.framework][0].toLowerCase()}"`)) {
        for (const pkg of CS_PACKAGES[ctx.framework]) {
          const add = await runCommand('dotnet', ['add', existing, 'package', pkg], ctx.repo, 600_000);
          if (add.code !== 0) return `Could not add ${pkg} to ${existing}:\n${add.output}`;
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
    if (created.code !== 0) return `Could not create the ${ctx.framework} test project:\n${created.output}`;
    await fs.rm(path.join(ctx.repo, dir, 'UnitTest1.cs'), { force: true });
    const linked = await runCommand('dotnet', ['add', planned, 'reference', src], ctx.repo);
    if (linked.code !== 0) return `Could not reference the source project:\n${linked.output}`;

    const srcPath = path.join(ctx.repo, src);
    const srcXml = await fs.readFile(srcPath, 'utf8');
    if (srcXml.includes('</Project>')) {
      const exclude = `  <ItemGroup>\n    <Compile Remove="${name}/**" />\n  </ItemGroup>\n`;
      await fs.writeFile(srcPath, srcXml.replace('</Project>', `${exclude}</Project>`), 'utf8');
    }
    ctx.files.push(planned);
    return ensureCoverlet(ctx);
  },
  runTests(ctx, testRel) {
    const projects = ctx.files.filter(isCsTestProject);
    const proj = nearestProject(testRel, projects) ?? projects[0] ?? '.';
    return runCommand('dotnet', ['test', proj], ctx.repo);
  },
  async coverage(ctx) {
    const projects = ctx.files.filter(isCsTestProject);
    if (projects.length === 0) throw new Error('No .NET test project found.');
    // Quoted on Windows because the shell would otherwise split the collector name at its space.
    const collect = process.platform === 'win32' ? '"--collect:XPlat Code Coverage"' : '--collect:XPlat Code Coverage';
    const lines = new Map<string, Map<number, boolean>>();
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
            for (const tag of cls[2].matchAll(/<line\b[^>]*>/g)) {
              const number = Number(/\bnumber="(\d+)"/.exec(tag[0])?.[1]);
              const hits = Number(/\bhits="(\d+)"/.exec(tag[0])?.[1]);
              covered.set(number, (covered.get(number) ?? false) || hits > 0);
            }
            lines.set(rel, covered);
          }
        }
      });
    }
    return [...lines].map(([rel, covered]) => ({
      rel,
      executable: covered.size,
      uncovered: [...covered].filter(([, hit]) => !hit).map(([line]) => line).sort((a, b) => a - b),
    }));
  },
};


const ADAPTERS: Record<string, LanguageAdapter> = {
  Python: python,
  'TypeScript/JavaScript': typescript,
  Go: go,
  Java: java,
  'C#': csharp,
};

export function adapterFor(language: string): LanguageAdapter {
  const adapter = ADAPTERS[language];
  if (!adapter) throw new Error(`No test support for ${language} yet.`);
  return adapter;
}
