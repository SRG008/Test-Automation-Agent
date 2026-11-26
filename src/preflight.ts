import * as fs from 'fs/promises';
import * as path from 'path';
import { pythonFor, TS_TOOLS } from './languages/adapters';
import { runCommand } from './shell';
import { Project, ToolCheck } from './types';

const exists = (p: string): Promise<boolean> => fs.access(p).then(() => true, () => false);

const installHint = (name: string): string => `Install ${name} and make sure it is on the PATH, restart VS Code, then click Recheck tools`;

// Checks that a program is on the PATH of this machine.
async function onPath(program: string, cwd: string): Promise<ToolCheck> {
  const lookup = process.platform === 'win32' ? 'where' : 'which';
  const run = await runCommand(lookup, [program], cwd, 20_000);
  return { name: program, ok: run.code === 0, hint: installHint(program), url: '', required: true };
}

// Finds the program a project's test command starts with and checks that it runs on this machine.
// Works for any language: whatever the command starts with must be installed.
async function checkProgram(repo: string, project: Project): Promise<ToolCheck | undefined> {
  const command = project.testCommand?.trim();
  if (!command) return undefined;
  const root = path.join(repo, project.root);
  const program = command.split(/\s+/)[0].replace(/^"|"$/g, '');

  if (program === 'python') {
    const interpreter = await pythonFor(root);
    const run = await runCommand(interpreter, ['--version'], root, 20_000);
    return { name: 'Python', ok: run.code === 0, hint: installHint('Python 3 (python.org)'), url: 'https://www.python.org/downloads/', required: true };
  }
  if (/[\\/]/.test(program)) {
    const found = await exists(path.resolve(root, program));
    return { name: program, ok: found, hint: `Create or install ${program} in the project, then click Recheck tools`, url: '', required: true };
  }
  return onPath(program, root);
}

// Work a project needs before tests can be written: packages, the chosen framework, and config files.
// An item with run can be installed by the host; autoRun items install without asking.
async function setupChecks(repo: string, project: Project): Promise<ToolCheck[]> {
  const root = path.join(repo, project.root);
  const items: ToolCheck[] = [];

  if (project.language === 'TypeScript/JavaScript' && (await exists(path.join(root, 'package.json')))) {
    items.push(await onPath('npm', root));
    const hasModules = await exists(path.join(root, 'node_modules'));
    const args = [(await exists(path.join(root, 'package-lock.json'))) ? 'ci' : 'install'];
    items.push({
      name: 'npm packages',
      ok: hasModules,
      hint: `Runs "npm ${args.join(' ')}" automatically`,
      url: '',
      required: true,
      run: { program: 'npm', args, cwd: root },
      autoRun: true,
    });
    const tool = TS_TOOLS[project.framework ?? ''];
    if (tool) {
      const installed = await exists(path.join(root, 'node_modules', tool, 'package.json'));
      items.push({
        name: `${tool} (test framework)`,
        ok: installed,
        hint: `Installs ${tool} as a dev dependency`,
        url: '',
        required: true,
        run: { program: 'npm', args: ['install', '-D', tool], cwd: root },
      });
    }
  }

  if (project.language === 'Python' && project.framework === 'pytest') {
    const installed = await frameworkInstalled(repo, 'Python', 'pytest', [project]);
    const interpreter = await pythonFor(root);
    items.push({
      name: 'pytest',
      ok: installed,
      hint: 'Installs pytest into the Python interpreter',
      url: '',
      required: true,
      run: { program: interpreter, args: ['-m', 'pip', 'install', 'pytest'], cwd: root },
    });
  }
  return items;
}

// Lists the tools and setup items the projects need and whether each one is ready on this machine.
export async function checkTools(repo: string, projects: Project[]): Promise<ToolCheck[]> {
  const results: ToolCheck[] = [];
  const seen = new Set<string>();
  const add = (check: ToolCheck | undefined): void => {
    if (!check || seen.has(check.name)) return;
    seen.add(check.name);
    results.push(check);
  };
  for (const project of projects) {
    add(await checkProgram(repo, project));
    for (const item of await setupChecks(repo, project)) add(item);
  }
  return results;
}

// Runs an install command the user allowed, or one that runs automatically. Throws with the end of the output if it fails.
export async function runSetup(run: NonNullable<ToolCheck['run']>): Promise<void> {
  const result = await runCommand(run.program, run.args, run.cwd, 600_000);
  if (result.code === 0) return;
  const tail = result.output.trim().split(/\r?\n/).slice(-6).join('\n');
  throw new Error(`Could not run "${[run.program, ...run.args].join(' ')}".\n${tail}`);
}

// Markers that show a test framework is already referenced in the project's build or project files.
const JAVA_MARKERS: Record<string, string> = { 'JUnit 5': 'junit-jupiter', TestNG: 'testng' };
const CS_MARKERS: Record<string, string> = { xUnit: 'xunit', NUnit: 'nunit', MSTest: 'mstest' };

// Lists .csproj files under a folder, skipping build output and dependency folders.
async function csprojFiles(root: string): Promise<string[]> {
  const entries = await fs.readdir(root, { recursive: true }).catch(() => [] as string[]);
  return entries.filter(e => e.endsWith('.csproj') && !/(^|[\\/])(bin|obj|node_modules)[\\/]/.test(e)).map(e => path.join(root, e));
}

// Whether the chosen test framework is already in the project. A missing framework is installed on Start, so this never blocks.
async function frameworkInstalled(repo: string, language: string, framework: string, projects: Project[]): Promise<boolean> {
  if (language === 'Python') {
    if (framework === 'unittest') return true;
    const py = await pythonFor(repo);
    return (await runCommand(py, ['-m', 'pytest', '--version'], repo, 20_000)).code === 0;
  }
  if (language === 'TypeScript/JavaScript') {
    return exists(path.join(repo, 'node_modules', framework.toLowerCase(), 'package.json'));
  }
  if (language === 'Go') return true; // go test ships with Go.
  for (const project of projects) {
    const root = path.join(repo, project.root);
    if (language === 'Java') {
      const marker = JAVA_MARKERS[framework];
      for (const build of ['pom.xml', 'build.gradle', 'build.gradle.kts']) {
        const text = await fs.readFile(path.join(root, build), 'utf8').catch(() => '');
        if (marker && text.toLowerCase().includes(marker)) return true;
      }
    }
    if (language === 'C#') {
      const marker = CS_MARKERS[framework];
      for (const proj of await csprojFiles(root)) {
        const text = await fs.readFile(proj, 'utf8').catch(() => '');
        if (marker && text.toLowerCase().includes(`include="${marker}`)) return true;
      }
    }
  }
  return false;
}

