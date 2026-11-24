import * as fs from 'fs/promises';
import * as path from 'path';
import { pythonFor } from './languages/adapters';
import { runCommand } from './shell';
import { Project, ToolCheck } from './types';

interface ToolSpec {
  name: string;
  command: string;
  args: string[];
  hint: string;
  url: string;
}

const NODE: ToolSpec = { name: 'Node.js', command: 'node', args: ['--version'], hint: 'Install Node.js from nodejs.org, restart VS Code, then click Recheck tools', url: 'https://nodejs.org/' };
const NPM: ToolSpec = { name: 'npm', command: 'npm', args: ['--version'], hint: 'npm comes with Node.js. Reinstall Node.js, restart VS Code, then click Recheck tools', url: 'https://nodejs.org/' };
const GO: ToolSpec = { name: 'Go', command: 'go', args: ['env', 'GOROOT'], hint: 'Install Go from go.dev, restart VS Code, then click Recheck tools', url: 'https://go.dev/dl/' };
// --list-sdks fails when only the runtime is installed, which the test projects need.
const DOTNET: ToolSpec = { name: '.NET SDK', command: 'dotnet', args: ['--list-sdks'], hint: 'Install the .NET SDK (not just the runtime), restart VS Code, then click Recheck tools', url: 'https://dotnet.microsoft.com/download' };
const JDK: ToolSpec = { name: 'Java JDK', command: 'javac', args: ['-version'], hint: 'Install a JDK 17 or newer, restart VS Code, then click Recheck tools', url: 'https://adoptium.net/' };
const MAVEN: ToolSpec = { name: 'Maven', command: 'mvn', args: ['-version'], hint: 'Install Maven, or add the Maven wrapper (mvnw) to the repo, then click Recheck tools', url: 'https://maven.apache.org/install.html' };
const GRADLE: ToolSpec = { name: 'Gradle', command: 'gradle', args: ['--version'], hint: 'Install Gradle, or add the Gradle wrapper (gradlew) to the repo, then click Recheck tools', url: 'https://gradle.org/install/' };

const exists = (p: string): Promise<boolean> => fs.access(p).then(() => true, () => false);

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

// Lists the tools the chosen language needs and whether each one runs on this machine.
export async function checkTools(repo: string, language: string, projects: Project[], framework?: string): Promise<ToolCheck[]> {
  const specs: ToolSpec[] = [];
  if (language === 'Python') {
    const interpreter = await pythonFor(repo);
    specs.push({ name: 'Python', command: interpreter, args: ['--version'], hint: 'Install Python 3 from python.org, restart VS Code, then click Recheck tools', url: 'https://www.python.org/downloads/' });
    specs.push({ name: 'pip', command: interpreter, args: ['-m', 'pip', '--version'], hint: 'Run "python -m ensurepip --upgrade" in a terminal, then click Recheck tools', url: 'https://pip.pypa.io/en/stable/installation/' });
  } else if (language === 'TypeScript/JavaScript') {
    specs.push(NODE, NPM);
  } else if (language === 'Go') {
    specs.push(GO);
  } else if (language === 'C#') {
    specs.push(DOTNET);
  } else if (language === 'Java') {
    specs.push(JDK);
    for (const project of projects.filter(p => p.language === 'Java')) {
      const root = path.join(repo, project.root);
      if (await exists(path.join(root, 'pom.xml')) && !(await exists(path.join(root, 'mvnw')))) specs.push(MAVEN);
      const gradle = (await exists(path.join(root, 'build.gradle'))) || (await exists(path.join(root, 'build.gradle.kts')));
      if (gradle && !(await exists(path.join(root, 'gradlew')))) specs.push(GRADLE);
    }
  }

  const seen = new Set<string>();
  const results: ToolCheck[] = [];
  for (const spec of specs) {
    if (seen.has(spec.name)) continue;
    seen.add(spec.name);
    const run = await runCommand(spec.command, spec.args, repo, 20_000);
    results.push({ name: spec.name, ok: run.code === 0, hint: spec.hint, url: spec.url, required: true });
  }
  if (framework) {
    const installed = await frameworkInstalled(repo, language, framework, projects);
    results.push({
      name: framework,
      ok: installed,
      hint: installed ? 'Already in the project' : 'Not in the project yet. It will be installed when you press Start.',
      url: '',
      required: false,
    });
  }
  return results;
}
