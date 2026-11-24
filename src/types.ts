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

export interface Report {
  branch: string;
  projects: string[];
  filesWritten: number;
  filesSkipped: number;
  coverageBefore: number;
  coverageAfter: number;
  files: FileResult[];
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
  | { type: 'selectFolder' }
  | { type: 'changeRepo' }
  | { type: 'setLanguage'; value: string }
  | { type: 'setFramework'; value: string }
  | { type: 'setBaseBranch'; value: string }
  | { type: 'setNewBranch'; value: string }
  | { type: 'createBranch' }
  | { type: 'start' }
  | { type: 'cancel' }
  | { type: 'openReport' }
  | { type: 'openFile'; value: string };
