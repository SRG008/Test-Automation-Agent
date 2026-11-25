import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { createBranchFromLatest, currentBranch, isGitRepo, listBranches, repoRoot, trackedFiles } from './gitOps';
import { detectProjects, frameworksFor, rankLanguages } from './detectLanguage';
import { checkTools } from './preflight';
import { runGeneration } from './testRunner';
import { writeReportFiles } from './reportHtml';
import { getHtml } from './webview';
import { AppState, Progress, Stage, ToolCheck, WebviewMessage } from './types';

export class AutoTestsViewProvider implements vscode.WebviewViewProvider {
  static readonly viewType = 'autoTests.panel';

  private view?: vscode.WebviewView;
  private cancelRequested = false;
  // One fixed pair of files, overwritten by each run, so old reports do not pile up.
  private readonly reportFile: string;
  private readonly htmlFile: string;
  private state: AppState = {
    projects: [],
    languages: [],
    frameworks: [],
    detectedFrameworks: [],
    frameworkNeeded: false,
    tools: [],
    branches: [],
    branchReady: false,
    running: false,
  };

  constructor(storageDir: string) {
    this.reportFile = path.join(storageDir, 'unit-test-report.pdf');
    this.htmlFile = path.join(storageDir, 'unit-test-report.html');
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = getHtml(view.webview.cspSource);
    view.webview.onDidReceiveMessage((msg: WebviewMessage) => this.handle(msg));
    const folderWatch = vscode.workspace.onDidChangeWorkspaceFolders(() => this.reloadRepo());
    view.onDidDispose(() => folderWatch.dispose());
    this.post();
  }

  private async handle(msg: WebviewMessage): Promise<void> {
    this.state.error = undefined;
    try {
      switch (msg.type) {
        case 'connect':
          await this.connect();
          break;
        case 'setLanguage':
          this.applyLanguage(msg.value);
          await this.refreshTools();
          break;
        case 'setFramework':
          this.state.framework = msg.value;
          await this.refreshTools();
          break;
        case 'setBaseBranch':
          this.state.baseBranch = msg.value;
          break;
        case 'setNewBranch':
          this.state.newBranch = msg.value;
          break;
        case 'recheckTools':
          await this.refreshTools();
          break;
        case 'createBranch':
          await this.createBranch();
          break;
        case 'start':
          await this.start();
          break;
        case 'cancel':
          this.cancelRequested = true;
          break;
        case 'openReport':
          await this.openReport();
          break;
        case 'openHtml':
          await this.openHtml();
          break;
        case 'savePdf':
          await this.savePdf();
          break;
        case 'openFile':
          await this.openFile(msg.value);
          break;
        case 'openUrl':
          await vscode.env.openExternal(vscode.Uri.parse(msg.value));
          break;
      }
    } catch (err) {
      this.state.error = err instanceof Error ? err.message : String(err);
    }
    this.post();
  }

  private stage(): Stage {
    const s = this.state;
    if (!s.model) return 'connect';
    if (!s.repoPath) return 'repo';
    if (s.running) return 'running';
    if (s.report) return 'done';
    if (!s.branchReady) return 'branch';
    return 'ready';
  }

  private post(): void {
    this.view?.webview.postMessage({ type: 'state', state: { ...this.state, stage: this.stage() } });
  }

  private async connect(): Promise<void> {
    const models = await vscode.lm.selectChatModels({ vendor: 'copilot' });
    if (models.length === 0) {
      throw new Error('No Copilot model found. Sign in to GitHub Copilot in VS Code, then press Connect again.');
    }
    this.state.model = models[0].name;
    await this.loadRepo();
  }

  // Re-reads the repository opened in VS Code when the workspace folders change.
  private async reloadRepo(): Promise<void> {
    if (!this.state.model || this.state.running) return;
    try {
      await this.loadRepo();
    } catch (err) {
      this.state.error = err instanceof Error ? err.message : String(err);
    }
    this.post();
  }

  // The repository is the git repo that holds the first workspace folder opened in VS Code.
  private async loadRepo(): Promise<void> {
    if (this.state.running) {
      throw new Error('A run is in progress. Wait for it to finish or cancel it first.');
    }
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!folder) {
      throw new Error('Open the repository folder in VS Code (File > Open Folder), then press Retry.');
    }
    if (!(await isGitRepo(folder))) {
      throw new Error('The opened folder is not a git repository.');
    }
    const repo = await repoRoot(folder);

    const projects = await detectProjects(repo, await trackedFiles(repo));
    if (projects.length === 0) {
      throw new Error('No supported project found. Supported: Python, TypeScript/JavaScript, Java, C# and Go.');
    }
    const base = await currentBranch(repo);
    if (!base) {
      throw new Error('HEAD is detached. Check out a branch in the opened repository first.');
    }
    const branches = await listBranches(repo);

    this.resetRepo();
    this.state.repoPath = repo;
    this.state.projects = projects;
    this.state.languages = rankLanguages(projects);
    this.applyLanguage(this.state.languages[0]);
    await this.refreshTools();
    this.state.branches = branches;
    this.state.baseBranch = branches.includes(base) ? base : branches[0];
    this.state.newBranch = defaultNewBranchName();
  }

  // Checks the tools the current language needs. Branch creation and generation stay blocked while any are missing.
  private async refreshTools(): Promise<void> {
    const { repoPath, language, projects, framework } = this.state;
    if (!repoPath || !language) return;
    this.state.tools = await checkTools(repoPath, language, projects.filter(p => p.language === language), framework);
  }

  private missingTools(): ToolCheck[] {
    return this.state.tools.filter(t => t.required && !t.ok);
  }

  // Tells the user what to install, with the same steps the checklist shows.
  private missingToolsError(missing: ToolCheck[]): string {
    return `Install the tools below first. ${missing.map(t => `${t.name}: ${t.hint}`).join('. ')}.`;
  }

  // Sets the language and works out the framework. A framework is only asked for when
  // some project of this language has no existing tests to read it from.
  private applyLanguage(language: string): void {
    const own = this.state.projects.filter(p => p.language === language);
    const detected = [...new Set(own.map(p => p.framework).filter((f): f is string => !!f))];
    const frameworkNeeded = own.some(p => !p.framework);
    const frameworks = frameworksFor(language);

    this.state.language = language;
    this.state.frameworks = frameworks;
    this.state.detectedFrameworks = detected;
    this.state.frameworkNeeded = frameworkNeeded;
    this.state.framework = frameworkNeeded ? frameworks[0] : detected[0];
  }

  private resetRepo(): void {
    if (this.state.running) {
      throw new Error('A run is in progress. Cancel it before changing the repository.');
    }
    this.state = {
      ...this.state,
      repoPath: undefined,
      projects: [],
      languages: [],
      language: undefined,
      frameworks: [],
      detectedFrameworks: [],
      frameworkNeeded: false,
      framework: undefined,
      tools: [],
      branches: [],
      baseBranch: undefined,
      newBranch: undefined,
      branchReady: false,
      report: undefined,
      progress: undefined,
    };
  }

  private async createBranch(): Promise<void> {
    const { repoPath, baseBranch, newBranch } = this.state;
    if (!repoPath || !baseBranch || !newBranch) {
      throw new Error('Choose a base branch and enter a new branch name first.');
    }
    const missing = this.missingTools();
    if (missing.length > 0) {
      throw new Error(this.missingToolsError(missing));
    }
    await createBranchFromLatest(repoPath, baseBranch, newBranch);
    this.state.branchReady = true;
  }

  private async start(): Promise<void> {
    const { repoPath, newBranch, language, framework, frameworkNeeded, branchReady, running } = this.state;
    if (running) return;
    if (!repoPath || !newBranch || !language || !branchReady) {
      throw new Error('Create the working branch before starting.');
    }
    if (frameworkNeeded && !framework) {
      throw new Error('Choose a test framework first.');
    }
    const missing = this.missingTools();
    if (missing.length > 0) {
      throw new Error(this.missingToolsError(missing));
    }

    const projects = this.state.projects.filter(p => p.language === language);
    this.state.running = true;
    this.state.report = undefined;
    this.cancelRequested = false;
    this.post();
    try {
      this.state.report = await runGeneration(
        { repoPath, branch: newBranch, language, framework, projects },
        (progress: Progress) => {
          this.state.progress = progress;
          this.post();
        },
        () => this.cancelRequested,
      );
      await fs.mkdir(path.dirname(this.reportFile), { recursive: true });
      await writeReportFiles(this.state.report, repoPath, this.htmlFile, this.reportFile);
    } finally {
      this.state.running = false;
    }
  }

  private async openReport(): Promise<void> {
    if (!this.state.report) return;
    await vscode.env.openExternal(vscode.Uri.file(this.reportFile));
  }

  private async openHtml(): Promise<void> {
    if (!this.state.report) return;
    await vscode.env.openExternal(vscode.Uri.file(this.htmlFile));
  }

  private async savePdf(): Promise<void> {
    if (!this.state.report) return;
    const target = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(path.join(os.homedir(), 'Downloads', 'unit-test-report.pdf')),
      filters: { PDF: ['pdf'] },
    });
    if (!target) return;
    await fs.copyFile(this.reportFile, target.fsPath);
    vscode.window.showInformationMessage(`Report saved to ${target.fsPath}`);
  }

  private async openFile(relative: string): Promise<void> {
    if (!this.state.repoPath) return;
    const uri = vscode.Uri.file(path.join(this.state.repoPath, relative));
    await vscode.window.showTextDocument(uri, { preview: false });
  }
}

function defaultNewBranchName(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `tests/auto-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
}
