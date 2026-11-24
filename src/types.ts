export type Stage = 'connect' | 'repo' | 'branch' | 'ready' | 'running' | 'done';

export interface StepStatus {
  label: string;
  status: 'pending' | 'active' | 'done';
}

export interface Progress {
  steps: StepStatus[];
  done: number;
  total: number;
  current?: string;
}

export interface FileResult {
  path: string;
  status: 'written' | 'skipped';
  note?: string;
}

// A folder with its own build or dependency file, e.g. the repo root or a monorepo package.
export interface Project {
  language: string;
  root: string; // repo-relative folder, '' for the repository root
  hasTests: boolean;
  sources: number;
  framework?: string; // detected from the tests that already exist
}

// Line coverage of one source file: how many executable lines it has and which of them no test runs.
export interface FileCoverage {
  rel: string;
  executable: number;
  uncovered: number[];
}

// 'functions' is the name-based fallback used when a language has no coverage tool wired up.
export interface CoverageSummary {
  unit: 'lines' | 'functions';
  covered: number;
  total: number;
  filesCovered: number; // source files with no uncovered lines
  filesTotal: number;
}

export interface Report {
  branch: string;
  projects: string[];
  filesWritten: number;
  filesSkipped: number;
  coverageBefore: CoverageSummary;
  coverageAfter: CoverageSummary;
  files: FileResult[];
}

// One tool the chosen language needs on this machine, and whether it was found.
export interface ToolCheck {
  name: string;
  ok: boolean;
  hint: string;
  url: string;
  // Required tools block the agent until installed. Test frameworks are optional: the agent installs them on Start.
  required: boolean;
}

export interface AppState {
  model?: string;
  repoPath?: string;
  projects: Project[];
  languages: string[];
  language?: string;
  frameworks: string[];
  detectedFrameworks: string[];
  frameworkNeeded: boolean;
  framework?: string;
  tools: ToolCheck[];
  branches: string[];
  baseBranch?: string;
  newBranch?: string;
  branchReady: boolean;
  running: boolean;
  progress?: Progress;
  report?: Report;
  error?: string;
}

export type WebviewMessage =
  | { type: 'connect' }
  | { type: 'setLanguage'; value: string }
  | { type: 'setFramework'; value: string }
  | { type: 'setBaseBranch'; value: string }
  | { type: 'setNewBranch'; value: string }
  | { type: 'recheckTools' }
  | { type: 'createBranch' }
  | { type: 'start' }
  | { type: 'cancel' }
  | { type: 'openReport' }
  | { type: 'openFile'; value: string }
  | { type: 'openUrl'; value: string };
