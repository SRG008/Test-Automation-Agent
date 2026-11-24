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
  passed: number;
  failed: number;
}

export interface Report {
  branch: string;
  filesWritten: number;
  testsPassed: number;
  testsFailed: number;
  coverageBefore: number;
  coverageAfter: number;
  skipped: number;
  files: FileResult[];
}

export interface AppState {
  model?: string;
  repoPath?: string;
  languages: string[];
  language?: string;
  frameworks: string[];
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
