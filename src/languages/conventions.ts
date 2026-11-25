// Test layout rules shared by the language adapters. Test files are recognised by name and folder patterns.
// Where a new test goes is learned from the test files the repo already has, so no folder structure is assumed.

export interface TestLayout {
  // Source folder prefix and the test folder prefix that replaces it.
  from: string;
  to: string;
  prefix: string;
  suffix: string;
  ext: string;
}

export interface TestStandard {
  dir(sourceDir: string): string;
  prefix: string;
  suffix: string;
}

const TEST_DIR = /^(tests?|__tests__|specs?)$|\.tests?$/i;
const TEST_STEM = /^test_|_test$|\.(test|spec)$|Tests?$/;

const segments = (path: string): string[] => path.split('/').filter(Boolean);
const baseName = (rel: string): string => rel.slice(rel.lastIndexOf('/') + 1);
const parentDir = (rel: string): string => rel.slice(0, Math.max(0, rel.lastIndexOf('/')));
const extension = (rel: string): string => {
  const base = baseName(rel);
  const i = base.lastIndexOf('.');
  return i <= 0 ? '' : base.slice(i);
};
const stem = (rel: string): string => {
  const base = baseName(rel);
  return base.slice(0, base.length - extension(rel).length);
};

// The name a test file would have for its source, e.g. "a" for test_a, a.test or ATest.
function coreOf(name: string): string | undefined {
  const core = name.replace(/^test_/, '').replace(/_test$/, '').replace(/\.(test|spec)$/, '').replace(/Tests?$/, '');
  return core && core !== name ? core : undefined;
}

// Where the core name sits in a test file name, as prefix and suffix around it.
function affixes(name: string, core: string): { prefix: string; suffix: string } {
  if (name.endsWith(core)) return { prefix: name.slice(0, -core.length), suffix: '' };
  const at = name.indexOf(core);
  return { prefix: name.slice(0, at), suffix: name.slice(at + core.length) };
}

// True for files in a test folder (tests, test, __tests__, spec, Foo.Tests) or with a test-style name.
export function isTestPath(rel: string): boolean {
  return segments(parentDir(rel)).some(d => TEST_DIR.test(d)) || TEST_STEM.test(stem(rel));
}

// Learns how this repo maps source files to test files by pairing each test with the source it covers.
// Folders are compared from the end, so "src/main/java/a/B.java" paired with "src/test/java/a/BTest.java"
// gives from "src/main" and to "src/test". The most common mapping wins.
export function learnLayout(sources: string[], tests: string[]): TestLayout | undefined {
  const sourcesByStem = new Map<string, string[]>();
  for (const source of sources) {
    const key = stem(source);
    sourcesByStem.set(key, [...(sourcesByStem.get(key) ?? []), source]);
  }
  const votes = new Map<string, { layout: TestLayout; count: number }>();
  for (const test of tests) {
    const ext = extension(test);
    const name = stem(test);
    const core = coreOf(name);
    if (!core) continue;
    for (const source of sourcesByStem.get(core) ?? []) {
      const sourceDirs = segments(parentDir(source));
      const testDirs = segments(parentDir(test));
      let shared = 0;
      while (
        shared < sourceDirs.length &&
        shared < testDirs.length &&
        sourceDirs[sourceDirs.length - 1 - shared] === testDirs[testDirs.length - 1 - shared]
      ) {
        shared++;
      }
      const layout: TestLayout = {
        from: sourceDirs.slice(0, sourceDirs.length - shared).join('/'),
        to: testDirs.slice(0, testDirs.length - shared).join('/'),
        ...affixes(name, core),
        ext,
      };
      const key = JSON.stringify(layout);
      const vote = votes.get(key) ?? { layout, count: 0 };
      vote.count++;
      votes.set(key, vote);
    }
  }
  return [...votes.values()].sort((a, b) => b.count - a.count)[0]?.layout;
}

// The test path for a source file. The learned layout is used when the source sits under its folder;
// otherwise the language standard applies.
export function placeTest(rel: string, layout: TestLayout | undefined, standard: TestStandard): string {
  const sourceDir = parentDir(rel);
  let dir = standard.dir(sourceDir);
  let prefix = standard.prefix;
  let suffix = standard.suffix;
  let ext = extension(rel);
  if (layout) {
    const rest =
      layout.from === ''
        ? sourceDir
        : sourceDir === layout.from
          ? ''
          : sourceDir.startsWith(`${layout.from}/`)
            ? sourceDir.slice(layout.from.length + 1)
            : undefined;
    if (rest !== undefined) {
      dir = [layout.to, rest].filter(Boolean).join('/');
      prefix = layout.prefix;
      suffix = layout.suffix;
      ext = layout.ext;
    }
  }
  return [dir, `${prefix}${stem(rel)}${suffix}${ext}`].filter(Boolean).join('/');
}
