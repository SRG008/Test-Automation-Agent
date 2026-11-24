import * as fs from 'fs/promises';
import * as path from 'path';
import { adapterFor } from './languages/adapters';
import { Project } from './types';

// Runnable frameworks offered in the dropdown: only those the engine can set up and run automatically.
export const FRAMEWORKS: Record<string, string[]> = {
  Python: ['pytest', 'unittest'],
  'TypeScript/JavaScript': ['Vitest'],
  Java: ['JUnit 5'],
  'C#': ['xUnit'],
  Go: ['go test'],
};

const SKIP_DIR = /(^|\/)(node_modules|vendor|dist|build|out|bin|obj|target|venv|\.venv|coverage)\//;
const SAMPLE_LIMIT = 50;

interface Marker {
  language: string;
  matches: (base: string) => boolean;
}

const MARKERS: Marker[] = [
  { language: 'Python', matches: b => ['pyproject.toml', 'setup.py', 'setup.cfg', 'requirements.txt'].includes(b) },
  { language: 'TypeScript/JavaScript', matches: b => b === 'package.json' },
  { language: 'Java', matches: b => ['pom.xml', 'build.gradle', 'build.gradle.kts'].includes(b) },
  { language: 'C#', matches: b => b.endsWith('.csproj') && !/test/i.test(b) },
  { language: 'Go', matches: b => b === 'go.mod' },
];

const baseOf = (rel: string): string => rel.slice(rel.lastIndexOf('/') + 1);
const dirOf = (rel: string): string => (rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '');

// Finds every project in the repo, at any depth. `files` are the repo-relative tracked files.
export async function detectProjects(repo: string, files: string[]): Promise<Project[]> {
  const found = new Map<string, { language: string; root: string }>();
  for (const rel of files) {
    if (SKIP_DIR.test(rel)) continue;
    for (const marker of MARKERS) {
      if (!marker.matches(baseOf(rel))) continue;
      const root = dirOf(rel);
      found.set(`${marker.language}|${root}`, { language: marker.language, root });
    }
  }

  const projects: Project[] = [];
  for (const { language, root } of found.values()) {
    const adapter = adapterFor(language);
    const prefix = root ? `${root}/` : '';
    const own = files
      .filter(f => f.startsWith(prefix) && !SKIP_DIR.test(f))
      .map(f => f.slice(prefix.length));
    projects.push({
      language,
      root,
      hasTests: own.some(adapter.isTest),
      sources: own.filter(adapter.isSource).length,
      framework: await detectExistingFramework(path.join(repo, root), language, own),
    });
  }
  return projects;
}

// Languages with existing tests come first, then by how much source code they have.
export function rankLanguages(projects: Project[]): string[] {
  const score = new Map<string, number>();
  for (const p of projects) {
    score.set(p.language, (score.get(p.language) ?? 0) + (p.hasTests ? 1_000_000 : 0) + p.sources);
  }
  return [...score.entries()].sort((a, b) => b[1] - a[1]).map(([language]) => language);
}

export function frameworksFor(language: string): string[] {
  return FRAMEWORKS[language] ?? [];
}

// Reads the test files and build or config files of a project to find the framework they already use.
async function detectExistingFramework(dir: string, language: string, files: string[]): Promise<string | undefined> {
  const read = (rel: string): Promise<string> => fs.readFile(path.join(dir, rel), 'utf8').catch(() => '');
  const sampleOf = async (rels: string[]): Promise<string> =>
    (await Promise.all(rels.slice(0, SAMPLE_LIMIT).map(read))).join('\n');

  if (language === 'C#') {
    const projects = files.filter(f => f.endsWith('.csproj') && /test/i.test(baseOf(f)));
    const hit = /Include="(xunit|nunit|MSTest)[^"]*"/i.exec(await sampleOf(projects));
    if (!hit) return undefined;
    const names: Record<string, string> = { xunit: 'xUnit', nunit: 'NUnit', mstest: 'MSTest' };
    return names[hit[1].toLowerCase()];
  }

  const tests = files.filter(adapterFor(language).isTest);
  if (tests.length === 0) return undefined;
  const sample = await sampleOf(tests);

  switch (language) {
    case 'Python': {
      const config = (await Promise.all(['pytest.ini', 'pyproject.toml', 'setup.cfg', 'tox.ini'].map(read))).join('\n');
      if (/^\s*(import pytest|from pytest)\b/m.test(sample) || /\[(tool\.pytest|pytest|tool:pytest)/.test(config)) {
        return 'pytest';
      }
      return /^\s*(import unittest|from unittest)\b/m.test(sample) ? 'unittest' : undefined;
    }
    case 'TypeScript/JavaScript': {
      const pkg = JSON.parse((await read('package.json')) || '{}') as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      if ('vitest' in deps) return 'Vitest';
      if ('jest' in deps) return 'Jest';
      if ('mocha' in deps) return 'Mocha';
      return undefined;
    }
    case 'Java':
      if (/org\.testng/.test(sample)) return 'TestNG';
      return /org\.junit\.jupiter/.test(sample) ? 'JUnit 5' : undefined;
    case 'Go':
      return 'go test';
    default:
      return undefined;
  }
}
