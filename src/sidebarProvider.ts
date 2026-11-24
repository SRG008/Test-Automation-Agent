import * as path from 'path';
import * as vscode from 'vscode';
import { createBranchFromLatest, defaultBranch, isGitRepo, listBranches } from './gitOps';
import { detectLanguages, frameworksFor, FRAMEWORKS } from './detectLanguage';
import { renderReportMarkdown, runGeneration } from './testRunner';
import { getHtml } from './webview';
import { AppState, Progress, Stage, WebviewMessage } from './types';

export class AutoTestsViewProvider implements vscode.WebviewViewProvider {
  static readonly viewType = 'autoTests.panel';

  private view?: vscode.WebviewView;
  private cancelRequested = false;
  private state: AppState = { languages: [], frameworks: [], branches: [], branchReady: false, running: false };

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = getHtml(view.webview.cspSource);
    view.webview.onDidReceiveMessage((msg: WebviewMessage) => this.handle(msg));
    this.post();
  }

  private async handle(msg: WebviewMessage): Promise<void> {
    this.state.error = undefined;
    try {
      switch (msg.type) {
        case 'connect':
          await this.connect();
          break;
        case 'selectFolder':
          await this.selectFolder();
          break;
        case 'changeRepo':
          this.resetRepo();
          break;
        case 'setLanguage':
          this.state.language = msg.value;
          this.state.frameworks = frameworksFor(msg.value);
          this.state.framework = this.state.frameworks[0];
          break;
        case 'setFramework':
          this.state.framework = msg.value;
          break;
        case 'setBaseBranch':
          this.state.baseBranch = msg.value;
          break;
        case 'setNewBranch':
          this.state.newBranch = msg.value;
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
        case 'openFile':
          await this.openFile(msg.value);
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
  }

  private async selectFolder(): Promise<void> {
    if (this.state.running) {
      throw new Error('A run is in progress. Wait for it to finish or cancel it first.');
    }
    const picked = await vscode.window.showOpenDialog({
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false,
      openLabel: 'Select repository',
    });
    if (!picked?.length) return;

    const repo = picked[0].fsPath;
    if (!(await isGitRepo(repo))) {
      throw new Error('The selected folder is not a git repository.');
    }

    const detected = await detectLanguages(repo);
    const branches = await listBranches(repo);
    const remoteDefault = await defaultBranch(repo);
    const languages = detected.length ? detected : Object.keys(FRAMEWORKS);
    const language = languages[0];
    const frameworks = frameworksFor(language);

    this.resetRepo();
    this.state.repoPath = repo;
    this.state.languages = languages;
    this.state.language = language;
    this.state.frameworks = frameworks;
    this.state.framework = frameworks[0];
    this.state.branches = branches;
    this.state.baseBranch = pickBaseBranch(branches, remoteDefault);
    this.state.newBranch = defaultNewBranchName();
  }

  private resetRepo(): void {
    if (this.state.running) {
      throw new Error('A run is in progress. Cancel it before changing the repository.');
    }
    this.state = {
      ...this.state,
      repoPath: undefined,
      languages: [],
      language: undefined,
      frameworks: [],
      framework: undefined,
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
    await createBranchFromLatest(repoPath, baseBranch, newBranch);
    this.state.branchReady = true;
  }

  private async start(): Promise<void> {
    const { repoPath, newBranch, language, framework, branchReady, running } = this.state;
    if (running) return;
    if (!repoPath || !newBranch || !language || !framework || !branchReady) {
      throw new Error('Create the working branch before starting.');
    }

    this.state.running = true;
    this.state.report = undefined;
    this.cancelRequested = false;
    this.post();
    try {
      this.state.report = await runGeneration(
        { repoPath, branch: newBranch, language, framework },
        (progress: Progress) => {
          this.state.progress = progress;
          this.post();
        },
        () => this.cancelRequested,
      );
    } finally {
      this.state.running = false;
    }
  }

  private async openReport(): Promise<void> {
    if (!this.state.report) return;
    const doc = await vscode.workspace.openTextDocument({
      language: 'markdown',
      content: renderReportMarkdown(this.state.report),
    });
    await vscode.window.showTextDocument(doc, { preview: false });
  }

  private async openFile(relative: string): Promise<void> {
    if (!this.state.repoPath) return;
    const uri = vscode.Uri.file(path.join(this.state.repoPath, relative));
    await vscode.window.showTextDocument(uri, { preview: false });
  }
}

function pickBaseBranch(branches: string[], remoteDefault: string | undefined): string | undefined {
  if (remoteDefault && branches.includes(remoteDefault)) return remoteDefault;
  return ['develop', 'main', 'master'].find(b => branches.includes(b)) ?? branches[0];
}

function defaultNewBranchName(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `tests/auto-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
}
