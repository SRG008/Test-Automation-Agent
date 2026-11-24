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

const NODE: ToolSpec = { name: 'Node.js', command: 'node', args: ['--version'], hint: 'Install Node.js', url: 'https://nodejs.org/' };
const NPM: ToolSpec = { name: 'npm', command: 'npm', args: ['--version'], hint: 'Install Node.js (includes npm)', url: 'https://nodejs.org/' };
const GO: ToolSpec = { name: 'Go', command: 'go', args: ['version'], hint: 'Install Go', url: 'https://go.dev/dl/' };
const DOTNET: ToolSpec = { name: '.NET SDK', command: 'dotnet', args: ['--version'], hint: 'Install the .NET SDK', url: 'https://dotnet.microsoft.com/download' };
const JDK: ToolSpec = { name: 'Java JDK', command: 'javac', args: ['-version'], hint: 'Install a JDK (17 or newer)', url: 'https://adoptium.net/' };
const MAVEN: ToolSpec = { name: 'Maven', command: 'mvn', args: ['-version'], hint: 'Install Maven, or add the Maven wrapper (mvnw) to the repo', url: 'https://maven.apache.org/install.html' };
const GRADLE: ToolSpec = { name: 'Gradle', command: 'gradle', args: ['--version'], hint: 'Install Gradle, or add the Gradle wrapper (gradlew) to the repo', url: 'https://gradle.org/install/' };

const exists = (p: string): Promise<boolean> => fs.access(p).then(() => true, () => false);

// Lists the tools the chosen language needs and whether each one runs on this machine.
export async function checkTools(repo: string, language: string, projects: Project[]): Promise<ToolCheck[]> {
  const specs: ToolSpec[] = [];
  if (language === 'Python') {
    const interpreter = await pythonFor(repo);
    specs.push({ name: 'Python', command: interpreter, args: ['--version'], hint: 'Install Python 3 from python.org', url: 'https://www.python.org/downloads/' });
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
    results.push({ name: spec.name, ok: run.code === 0, hint: spec.hint, url: spec.url });
  }
  return results;
}
