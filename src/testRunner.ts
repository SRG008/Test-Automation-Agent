import { Progress, Report, StepStatus } from './types';

export interface RunConfig {
  repoPath: string;
  branch: string;
  language: string;
  framework: string;
}

const STEP_LABELS = [
  'Detecting test layout',
  'Finding untested files',
  'Writing tests with Copilot',
  'Running tests',
  'Measuring coverage',
];

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// Placeholder engine: the progress flow is real, but Copilot generation is not wired in yet.
export async function runGeneration(
  config: RunConfig,
  onProgress: (p: Progress) => void,
  isCancelled: () => boolean,
): Promise<Report> {
  const steps: StepStatus[] = STEP_LABELS.map(label => ({ label, status: 'pending' }));
  const snapshot = (done: number, current?: string): Progress => ({
    steps: steps.map(s => ({ ...s })),
    done,
    total: steps.length,
    current,
  });

  for (let i = 0; i < steps.length; i++) {
    if (isCancelled()) {
      throw new Error('Run cancelled.');
    }
    steps[i].status = 'active';
    onProgress(snapshot(i, steps[i].label));
    await delay(800);
    steps[i].status = 'done';
    onProgress(snapshot(i + 1));
  }

  return {
    branch: config.branch,
    filesWritten: 0,
    testsPassed: 0,
    testsFailed: 0,
    coverageBefore: 0,
    coverageAfter: 0,
    skipped: 0,
    files: [],
  };
}

export function renderReportMarkdown(r: Report): string {
  const lines = [
    '# Unit Test Generation Report',
    '',
    `**Branch:** \`${r.branch}\``,
    '',
    '| Metric | Value |',
    '|---|---|',
    `| Files written | ${r.filesWritten} |`,
    `| Tests passed | ${r.testsPassed} |`,
    `| Tests failed | ${r.testsFailed} |`,
    `| Coverage | ${r.coverageBefore}% → ${r.coverageAfter}% |`,
    `| Skipped | ${r.skipped} |`,
    '',
    '## Files',
    '',
    ...(r.files.length
      ? r.files.map(f => `- \`${f.path}\`: ${f.passed} passed, ${f.failed} failed`)
      : ['_No test files written yet._']),
  ];
  return lines.join('\n');
}
