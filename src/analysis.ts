import * as fs from 'fs/promises';
import * as path from 'path';
import { askCopilot } from './copilot';
import { Project } from './types';

// Copilot finds each project's language, source and test files, frameworks, and test command from the
// repo's own files. No language, framework, or build-file names are fixed in this module.

const TREE_LIMIT = 1500;
const SKIP_DIR = /(^|\/)(node_modules|vendor|dist|build|out|bin|obj|target|venv|\.venv|coverage)\//;
const FILE_CHARS = 1500;
const TEST_CHARS = 3000;
const MAX_BUILD_FILES = 4;
const MAX_TEST_FILES = 3;

interface StructureReply {
  projects?: unknown[];
}

interface TestSetupReply {
  framework?: string | null;
  testCommand?: string | null;
  style?: string | null;
}

// Finds every project in the repo and what its test setup is. Throws if Copilot gives no usable structure.
export async function detectProjects(repo: string, files: string[]): Promise<Project[]> {
  const visible = files.filter(f => !SKIP_DIR.test(f));
  const reply = parseJson<StructureReply>(await askCopilot(structurePrompt(visible)));
  const known = new Set(visible);
  const drafts = (reply?.projects ?? []).map(p => toDraft(p, known, visible)).filter((d): d is Draft => d !== undefined);
  if (drafts.length === 0) {
    throw new Error('Copilot did not find a project in this repository. Check that it holds source code, then press Retry.');
  }

  const roots = drafts.map(d => d.root);
  const projects: Project[] = [];
  for (const draft of drafts) {
    const prefix = draft.root ? `${draft.root}/` : '';
    const own = visible.filter(f => f.startsWith(prefix) && ownerOf(roots, f) === draft.root);
    const project: Project = {
      ...draft,
      hasTests: draft.testFiles.length > 0,
      sources: own.filter(rel => isSourceFile(draft, rel)).length,
    };
    if (project.hasTests) await readTestSetup(repo, project);
    if (project.framework && !project.testCommand) project.testCommand = await commandForFramework(repo, project);
    projects.push(project);
  }
  return projects;
}

// The test command for a project after the user picks a framework. Copilot reads the project's build files.
export async function commandForFramework(repo: string, project: Project): Promise<string | undefined> {
  if (!project.framework) return undefined;
  const build = await readFiles(repo, project.buildFiles, FILE_CHARS, MAX_BUILD_FILES);
  const prompt = [
    `This ${project.language} project uses ${project.framework} for its unit tests.`,
    'Using only its build and configuration files below, give the shell command that runs the whole test suite.',
    'Reply with JSON only, in one fenced block, as {"testCommand": "..."}.',
    ...build.map(f => `--- ${f.rel}\n${f.text}`),
  ].join('\n\n');
  const reply = parseJson<TestSetupReply>(await askCopilot(prompt));
  return reply?.testCommand?.trim() || undefined;
}

// Languages with existing tests come first, then by how much source code they have.
export function rankLanguages(projects: Project[]): string[] {
  const score = new Map<string, number>();
  for (const p of projects) {
    score.set(p.language, (score.get(p.language) ?? 0) + (p.hasTests ? 1_000_000 : 0) + p.sources);
  }
  return [...score.entries()].sort((a, b) => b[1] - a[1]).map(([language]) => language);
}

// The project a repo-relative file belongs to: the deepest project folder that holds it.
export function ownerOf(roots: string[], repoRel: string): string {
  return roots
    .filter(r => r === '' || repoRel.startsWith(`${r}/`))
    .sort((a, b) => b.length - a.length)[0];
}

// A source file is one of the project's extensions and is not a test file. Both lists come from Copilot.
export function isSourceFile(project: Pick<Project, 'extensions' | 'testFiles'>, rel: string): boolean {
  return project.extensions.includes(extensionOf(rel)) && !project.testFiles.includes(rel);
}

export function extensionOf(rel: string): string {
  const base = rel.slice(rel.lastIndexOf('/') + 1);
  const i = base.lastIndexOf('.');
  return i <= 0 ? '' : base.slice(i).toLowerCase();
}

type Draft = Omit<Project, 'hasTests' | 'sources'>;

// Checks one project from Copilot's reply. Paths must be files in the repo, and the folder must exist.
function toDraft(raw: unknown, known: Set<string>, visible: string[]): Draft | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const p = raw as Record<string, unknown>;
  const root = typeof p.root === 'string' ? p.root.trim().replace(/^\.\/?/, '').replace(/\/+$/, '') : undefined;
  const language = typeof p.language === 'string' ? p.language.trim() : '';
  if (root === undefined || !language) return undefined;
  if (root !== '' && !visible.some(f => f.startsWith(`${root}/`))) return undefined;

  const strings = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string' && s.trim() !== '').map(s => s.trim()) : [];
  const prefix = root ? `${root}/` : '';
  const inRepo = (repoRel: string): boolean => known.has(repoRel);

  return {
    language,
    root,
    extensions: strings(p.extensions).map(e => e.toLowerCase()).filter(e => e.startsWith('.')),
    buildFiles: strings(p.buildFiles).filter(inRepo),
    testFiles: strings(p.testFiles).filter(inRepo),
    frameworkOptions: [...new Set(strings(p.frameworkOptions))],
  };
}

// Reads the existing test setup: the framework the tests use, the test command, and how the tests are written.
async function readTestSetup(repo: string, project: Project): Promise<void> {
  const build = await readFiles(repo, project.buildFiles, FILE_CHARS, MAX_BUILD_FILES);
  const tests = await readFiles(repo, project.testFiles, TEST_CHARS, MAX_TEST_FILES);
  const prompt = [
    `You are inspecting a ${project.language} project. Its build files and existing test files are below.`,
    'Work out the test setup from these files alone. Do not guess a framework that the files do not show.',
    'Reply with JSON only, in one fenced block, with these keys:',
    '"framework": the test framework these tests use, as a short name (for example "pytest", "JUnit 5", "RSpec"), or null if none is shown.',
    '"testCommand": the shell command that runs the whole test suite, or null.',
    '"style": two or three sentences describing how the tests are written: file name and location, imports, structure, assertion style, and naming. Write it so another author can match it.',
    ...build.map(f => `--- ${f.rel}\n${f.text}`),
    ...tests.map(f => `--- ${f.rel}\n${f.text}`),
  ].join('\n\n');
  const reply = parseJson<TestSetupReply>(await askCopilot(prompt));
  if (!reply) return;

  const framework = reply.framework?.trim();
  if (framework) {
    project.framework = framework;
    if (!project.frameworkOptions.includes(framework)) project.frameworkOptions = [...project.frameworkOptions, framework];
  }
  project.testCommand = reply.testCommand?.trim() || undefined;
  project.styleNote = reply.style?.trim() || undefined;
}

function structurePrompt(visible: string[]): string {
  const shown = visible.slice(0, TREE_LIMIT);
  const hidden = visible.length - shown.length;
  return [
    'You are inspecting the file list of a git repository. Find every project in it: a folder with its own build, package, or dependency file, or the repository root when it holds source code of its own.',
    'For each project report:',
    '- root: its folder relative to the repository root, or "" for the root.',
    '- language: the language its source is written in, with one name for the project (for example Python, TypeScript/JavaScript, Java, C#, Go).',
    '- extensions: the source file extensions of that language, such as ".py".',
    '- buildFiles: repository paths of its build, package, and configuration files.',
    '- testFiles: repository paths of the unit test files that test this project. They may sit in a separate folder from the project, such as a tests/ folder holding one test project per source project, so search the whole list. A test project is not a project of its own, so do not list it.',
    '- frameworkOptions: common unit test frameworks for that language, most common first.',
    'Use only paths that appear in the list. Reply with JSON only, in one fenced block, as {"projects": [...]}.',
    `Repository files${hidden > 0 ? ` (the list is cut short; ${hidden} more files are not shown)` : ''}:`,
    shown.join('\n'),
  ].join('\n');
}

// Reads the files Copilot named, from repo-relative paths. A missing file is skipped; long files are cut short.
async function readFiles(
  repo: string,
  rels: string[],
  maxChars: number,
  maxFiles: number,
): Promise<{ rel: string; text: string }[]> {
  return Promise.all(
    rels.slice(0, maxFiles).map(async rel => ({
      rel,
      text: await fs.readFile(path.join(repo, rel), 'utf8').then(t => t.slice(0, maxChars)).catch(() => ''),
    })),
  );
}

// Reads the first JSON object in a reply. An unreadable reply gives undefined.
function parseJson<T>(reply: string): T | undefined {
  const match = /\{[\s\S]*\}/.exec(reply);
  if (!match) return undefined;
  try {
    return JSON.parse(match[0]) as T;
  } catch {
    return undefined;
  }
}
