export type Stage = 'connect' | 'repo' | 'branch' | 'ready' | 'running' | 'done';

export interface StepStatus {
  label: string;
  status: 'pending' | 'active' | 'done';
  estimateSec: number; // rough expected duration, shown to the user as "estimated time left"
  startedAt?: number; // epoch ms when the step became active
}

// The source file being handled right now, shown as "file X of Y".
export interface LiveStatus {
  index: number; // 1-based position in the plan
  total: number;
  file: string; // source file being covered
  phase: string; // e.g. "Asking Copilot for tests", "Running tests"
  tests: string[]; // test names in the latest generated test file
}

export interface Progress {
  steps: StepStatus[];
  done: number;
  total: number;
  live?: LiveStatus;
  startedAt: number; // epoch ms when the run started
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
  framework?: string; // detected from the tests that already exist, or chosen in the sidebar
  frameworkOptions: string[]; // frameworks offered in the sidebar for this language, from Copilot
  testCommand?: string; // runs this project's test suite, derived from the framework in the background
  styleNote?: string; // how the existing tests are written, read by Copilot; guides new tests
  extensions: string[]; // source file extensions of the language, from Copilot, e.g. ".py"
  buildFiles: string[]; // build, package, and config files, relative to the repository root
  testFiles: string[]; // existing unit test files, relative to the repository root; may sit outside the project folder
}

export interface Counts {
  covered: number;
  total: number;
}

// Line coverage of one source file: how many executable lines it has and which of them no test runs.
// branches and methods are set only when the language's coverage tool reports them.
export interface FileCoverage {
  rel: string;
  executable: number;
  covered: number[];
  uncovered: number[];
  branches?: Counts;
  methods?: Counts;
}

// 'functions' is the name-based fallback used when a language has no coverage tool wired up.
// 'none' means no coverage tool is known for the language, so coverage is reported as not available.
export interface CoverageSummary {
  unit: 'lines' | 'functions' | 'none';
  covered: number;
  total: number;
  filesCovered: number; // source files with no uncovered lines
  filesTotal: number;
  branches?: Counts; // present only when every measured project reports branches
  methods?: Counts; // present only when every measured project reports methods
}

// Covered and total for one source file. total is undefined when the file has no coverage data.
export interface FileCount {
  covered: number;
  total?: number;
}

export interface FileCoverageRow {
  path: string;
  before?: FileCount;
  after: FileCount;
  missing: string; // uncovered line numbers, or function names when only name-based coverage exists
}

export interface Report {
  branch: string;
  generatedAt: string;
  projects: string[];
  filesWritten: number;
  filesSkipped: number;
  coverageBefore: CoverageSummary;
  coverageAfter: CoverageSummary;
  fileCoverage: FileCoverageRow[];
  // Line-level coverage of each measured file, after the run. Files without line data are missing here.
  coverageFiles: FileCoverage[];
  files: FileResult[];
  // Source files that still have uncovered code after the run.
  remaining: string[];
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
  // The project the user picked in the sidebar, for the chosen language. Undefined until picked when there are several.
  projectRoot?: string;
  tools: ToolCheck[];
  branches: string[];
  baseBranch?: string;
  newBranch?: string;
  branchReady: boolean;
  running: boolean;
  // Source files of the chosen language, and the ones the user ticked for "Choose files".
  sourceFiles: string[];
  selected: string[];
  choosing: boolean;
  progress?: Progress;
  report?: Report;
  error?: string;
}

export type WebviewMessage =
  | { type: 'connect' }
  | { type: 'setLanguage'; value: string }
  | { type: 'setProject'; value: string }
  | { type: 'setFramework'; root: string; value: string }
  | { type: 'setBaseBranch'; value: string }
  | { type: 'setNewBranch'; value: string }
  | { type: 'recheckTools' }
  | { type: 'createBranch' }
  | { type: 'start' }
  | { type: 'chooseFiles' }
  | { type: 'backToOptions' }
  | { type: 'toggleFile'; value: string; checked: boolean }
  | { type: 'toggleFolder'; value: string; checked: boolean }
  | { type: 'startSelected' }
  | { type: 'cancel' }
  | { type: 'openHtml' }
  | { type: 'savePdf' }
  | { type: 'openFile'; value: string }
  | { type: 'openUrl'; value: string };
