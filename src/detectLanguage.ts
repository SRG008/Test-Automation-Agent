import * as fs from 'fs/promises';

export const FRAMEWORKS: Record<string, string[]> = {
  Python: ['pytest', 'unittest'],
  'TypeScript/JavaScript': ['Vitest', 'Jest', 'Mocha'],
  Java: ['JUnit 5', 'TestNG'],
  'C#': ['xUnit', 'NUnit', 'MSTest'],
  Go: ['go test'],
};

interface Marker {
  language: string;
  names: string[];
  extensions?: string[];
}

const MARKERS: Marker[] = [
  { language: 'Python', names: ['pyproject.toml', 'setup.py', 'setup.cfg', 'requirements.txt'] },
  { language: 'TypeScript/JavaScript', names: ['package.json', 'tsconfig.json'] },
  { language: 'Java', names: ['pom.xml', 'build.gradle', 'build.gradle.kts'] },
  { language: 'C#', names: [], extensions: ['.sln', '.csproj'] },
  { language: 'Go', names: ['go.mod'] },
];

// Checks only the repo root; nested projects are not scanned yet.
export async function detectLanguages(repo: string): Promise<string[]> {
  const entries = await fs.readdir(repo).catch(() => [] as string[]);
  return MARKERS.filter(
    m =>
      m.names.some(n => entries.includes(n)) ||
      (m.extensions ?? []).some(ext => entries.some(e => e.endsWith(ext))),
  ).map(m => m.language);
}

export function frameworksFor(language: string): string[] {
  return FRAMEWORKS[language] ?? [];
}
