import * as fs from 'fs/promises';
import * as path from 'path';
import { CommandResult, runCommand } from '../shell';

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
}

export function dirOf(rel: string): string {
  const i = rel.lastIndexOf('/');
  return i < 0 ? '' : rel.slice(0, i);
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
async function pythonFor(repo: string): Promise<string> {
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
    if (ctx.framework === 'unittest') return undefined;
    if ((await runCommand(py, ['-m', 'pytest', '--version'], ctx.repo)).code === 0) return undefined;
    const install = await runCommand(py, ['-m', 'pip', 'install', 'pytest'], ctx.repo);
    return install.code === 0 ? undefined : `Could not install pytest:\n${install.output}`;
  },
  async runTests(ctx, testRel) {
    const py = await pythonFor(ctx.repo);
    if (ctx.framework === 'unittest') {
      return runCommand(py, ['-m', 'unittest', 'discover', '-s', dirOf(testRel) || '.', '-p', baseOf(testRel)], ctx.repo);
    }
    return runCommand(py, ['-m', 'pytest', testRel, '-q'], ctx.repo);
  },
};

// ---------- TypeScript / JavaScript (Vitest, Jest, Mocha) ----------

const TS_FILE = /\.(ts|tsx|js|jsx|mjs|cjs)$/;
const isTsTest = (rel: string): boolean =>
  TS_FILE.test(rel) && (/\.(test|spec)\.[^/]+$/.test(baseOf(rel)) || /(^|\/)(__tests__|tests?)\//.test(rel));

const TS_TOOLS: Record<string, string> = { Vitest: 'vitest', Jest: 'jest', Mocha: 'mocha' };

const typescript: LanguageAdapter = {
  language: 'TypeScript/JavaScript',
  testRules: framework =>
    `Use the ${framework} API the project already uses. Import the code under test from its module path relative to the test file. Mock network, clock and file system access so tests are deterministic.`,
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
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    const tool = TS_TOOLS[ctx.framework];
    if (!tool) return `${ctx.framework} is not supported for TypeScript/JavaScript yet.`;
    if (tool in deps) return undefined;
    if (ctx.framework !== 'Vitest') {
      return `${ctx.framework} is not installed in this repo. Automatic setup is only available for Vitest.`;
    }
    const install = await runCommand('npm', ['install', '-D', tool], ctx.repo, 600_000);
    return install.code === 0 ? undefined : `Could not install ${tool}:\n${install.output}`;
  },
  runTests(ctx, testRel) {
    const args =
      ctx.framework === 'Jest' ? ['jest', testRel] : ctx.framework === 'Mocha' ? ['mocha', testRel] : ['vitest', 'run', testRel];
    return runCommand('npx', args, ctx.repo);
  },
};

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
};

// ---------- Java (JUnit 5 with Maven or Gradle) ----------

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
    if (!build) return 'No pom.xml or build.gradle found. Add a Maven or Gradle build with JUnit 5 first.';
    const text = await fs.readFile(path.join(ctx.repo, build), 'utf8');
    const needed = ctx.framework === 'TestNG' ? /testng/i : /junit/i;
    return needed.test(text) ? undefined : `Add ${ctx.framework} to the test dependencies in ${build}, then try again.`;
  },
  runTests(ctx, testRel) {
    const className = stemOf(testRel);
    if (ctx.files.includes('pom.xml')) {
      return runCommand('mvn', [`-Dtest=${className}`, 'test'], ctx.repo);
    }
    const wrapper = process.platform === 'win32' ? 'gradlew' : './gradlew';
    const gradle = ctx.files.includes('gradlew') ? wrapper : 'gradle';
    return runCommand(gradle, ['test', '--tests', className], ctx.repo);
  },
};

// ---------- C# (xUnit) ----------

const isCsTest = (rel: string): boolean => rel.endsWith('.cs') && /(^|\/)[^/]*tests?[^/]*\//i.test(rel);
const isCsTestProject = (rel: string): boolean => rel.endsWith('.csproj') && /test/i.test(baseOf(rel));
const csTestProject = (ctx: AdapterContext): string | undefined => ctx.files.find(isCsTestProject);

// Where a new xUnit project goes: a <Project>.Tests folder inside the source project's folder.
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
    if (csTestProject(ctx)) return undefined;
    const src = ctx.files.find(f => f.endsWith('.csproj') && !isCsTestProject(f));
    const planned = plannedCsTestProject(ctx);
    if (!src || !planned) return 'No .csproj found. Open a .NET project, then try again.';

    const dir = dirOf(planned);
    const name = stemOf(planned);
    const created = await runCommand('dotnet', ['new', 'xunit', '-n', name, '-o', dir || '.'], ctx.repo);
    if (created.code !== 0) return `Could not create the xUnit test project:\n${created.output}`;
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
    return undefined;
  },
  runTests(ctx, testRel) {
    const projects = ctx.files.filter(isCsTestProject);
    const proj = nearestProject(testRel, projects) ?? projects[0] ?? '.';
    return runCommand('dotnet', ['test', proj], ctx.repo);
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
