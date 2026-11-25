import * as fs from 'fs/promises';
import * as path from 'path';
import { pythonFor } from './languages/adapters';
import { runCommand } from './shell';
import { Project, ToolCheck } from './types';

const exists = (p: string): Promise<boolean> => fs.access(p).then(() => true, () => false);

// Finds the program a project's test command starts with and checks that it runs on this machine.
// Works for any language: whatever the command starts with must be installed.
async function checkProgram(repo: string, project: Project): Promise<ToolCheck | undefined> {
  const command = project.testCommand?.trim();
  if (!command) return undefined;
  const root = path.join(repo, project.root);
  const program = command.split(/\s+/)[0].replace(/^"|"$/g, '');
  const hint = (name: string): string => `Install ${name} and make sure it is on the PATH, restart VS Code, then click Recheck tools`;

  if (program === 'python') {
    const interpreter = await pythonFor(root);
    const run = await runCommand(interpreter, ['--version'], root, 20_000);
    return { name: 'Python', ok: run.code === 0, hint: hint('Python 3 (python.org)'), url: 'https://www.python.org/downloads/', required: true };
  }
  if (/[\\/]/.test(program)) {
    const found = await exists(path.resolve(root, program));
    return { name: program, ok: found, hint: `Create or install ${program} in the project, then click Recheck tools`, url: '', required: true };
  }
  const lookup = process.platform === 'win32' ? 'where' : 'which';
  const run = await runCommand(lookup, [program], root, 20_000);
  return { name: program, ok: run.code === 0, hint: hint(program), url: '', required: true };
}

// Lists the tools the projects' test commands need and whether each one runs on this machine.
export async function checkTools(repo: string, projects: Project[]): Promise<ToolCheck[]> {
  const results: ToolCheck[] = [];
  const seen = new Set<string>();
  for (const project of projects) {
    const check = await checkProgram(repo, project);
    if (!check || seen.has(check.name)) continue;
    seen.add(check.name);
    results.push(check);
  }
  return results;
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

