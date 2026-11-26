import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { createBranchFromLatest, currentBranch, isGitRepo, listBranches, repoRoot, trackedFiles } from './gitOps';
import { commandForFramework, detectProjects, isFrontendProject, ownerOf, rankLanguages } from './analysis';
import { resetCopilotStop, stopCopilotRequests } from './copilot';
import { stopRunningCommands } from './shell';
import { checkTools, runSetup } from './preflight';
import { SUPPORTED_LANGUAGES, useSupportedFrameworks } from './languages/adapters';
import { filesNeedingTests, listSourceFiles, runGeneration } from './testRunner';
import { writeReportFiles } from './reportHtml';
import { getHtml } from './webview';
import { AppState, Progress, Project, Stage, ToolCheck, WebviewMessage } from './types';

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
    unsupported: [],
    tools: [],
    branches: [],
    branchReady: false,
    running: false,
    sourceFiles: [],
    selected: [],
    choosing: false,
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
        case 'backToConnect':
          this.resetRepo();
          this.state.showConnect = true;
          break;
        case 'setLanguage':
          this.state.language = msg.value;
          this.state.projectRoot = this.defaultProjectRoot();
          await this.refreshSources();
          await this.refreshTools();
          break;
        case 'setProject': {
          const chosen = this.languageProjects().find(p => p.root === msg.value);
          if (!chosen) throw new Error('Choose one of the projects listed for this language.');
          this.state.projectRoot = chosen.root;
          await this.refreshSources();
          break;
        }
        case 'setFramework': {
          const project = this.state.projects.find(p => p.root === msg.root && p.language === this.state.language);
          if (project && this.state.repoPath) {
            project.framework = msg.value || undefined;
            project.testCommand = await commandForFramework(this.state.repoPath, project);
          }
          await this.refreshTools();
          break;
        }
        case 'setBaseBranch':
          this.state.baseBranch = msg.value;
          break;
        case 'setNewBranch':
          this.state.newBranch = msg.value;
          break;
        case 'recheckTools':
          await this.refreshTools();
          break;
        case 'runSetup':
          await this.installTool(msg.value);
          break;
        case 'createBranch':
          await this.createBranch();
          break;
        case 'start':
          await this.start(false);
          break;
        case 'chooseFiles':
          await this.chooseFiles();
          break;
        case 'backToOptions':
          this.state.choosing = false;
          break;
        case 'backToBranch':
          this.state.branchReady = false;
          this.state.choosing = false;
          this.state.selected = [];
          break;
        // Steps back one screen: completed → ready, file chooser → ready, ready → branch. Ignored while a run is going.
        case 'goBack':
          if (this.state.running) break;
          if (this.state.report) {
            this.state.report = undefined;
          } else if (this.state.choosing) {
            this.state.choosing = false;
          } else {
            this.state.branchReady = false;
            this.state.selected = [];
          }
          break;
        case 'toggleFile':
          this.setSelected([msg.value], msg.checked);
          break;
        case 'toggleFolder':
          this.setSelected(this.filesIn(msg.value), msg.checked);
          break;
        case 'startSelected':
          await this.start(true);
          break;
        case 'cancel':
          if (!this.state.running || this.cancelRequested) break;
          this.cancelRequested = true;
          this.state.status = 'Cancelling…';
          this.post();
          stopCopilotRequests();
          stopRunningCommands();
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
    if (!s.model || s.showConnect) return 'connect';
    if (!s.repoPath) return 'repo';
    if (s.projects.length === 0) return 'unsupported';
    if (s.running) return 'running';
    if (s.report) return 'done';
    if (!s.branchReady) return 'branch';
    return 'ready';
  }

  private post(): void {
    this.view?.webview.postMessage({ type: 'state', state: { ...this.state, stage: this.stage() } });
  }

  private async connect(): Promise<void> {
    this.state.status = 'Connecting to Copilot…';
    this.state.showConnect = false;
    this.post();
    try {
      const models = await vscode.lm.selectChatModels({ vendor: 'copilot' });
      if (models.length === 0) {
        throw new Error('No Copilot model found. Sign in to GitHub Copilot in VS Code, then press Connect again.');
      }
      this.state.model = models[0].name;
      this.state.status = 'Analyzing the code…';
      this.post();
      await this.loadRepo();
    } finally {
      this.state.status = undefined;
    }
  }

  // Re-reads the repository opened in VS Code when the workspace folders change.
  private async reloadRepo(): Promise<void> {
    if (!this.state.model || this.state.running || this.state.showConnect) return;
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

    const files = await trackedFiles(repo);
    const detected = await detectProjects(repo, files);
    if (detected.length === 0) {
      throw new Error('No project found. The repository needs a build or package file, or source code in a recognized language.');
    }
    const frontend = await Promise.all(detected.map(p => isFrontendProject(repo, p)));
    const frontendRoots = detected.filter((_, i) => frontend[i]).map(p => p.root).filter(r => r !== '');
    // A project inside a frontend folder (for example a Capacitor android/ or ios/ shell) belongs to that frontend.
    const isFrontend = detected.map((p, i) => frontend[i] || frontendRoots.some(r => p.root.startsWith(`${r}/`)));
    const unsupported = [...new Set(detected.filter((_, i) => isFrontend[i]).map(p => p.root || 'repository root'))];
    // Only backend languages the agent can write tests for are listed; other languages are left out.
    const projects = detected.filter((p, i) => !isFrontend[i] && SUPPORTED_LANGUAGES.includes(p.language)).map(useSupportedFrameworks);
    if (projects.length === 0) {
      // Only frontend projects: show the "not supported yet" screen instead of the setup steps.
      this.resetRepo();
      this.state.repoPath = repo;
      this.state.unsupported = unsupported;
      return;
    }
    const base = await currentBranch(repo);
    if (!base) {
      throw new Error('HEAD is detached. Check out a branch in the opened repository first.');
    }
    const branches = await listBranches(repo);

    this.resetRepo();
    this.state.repoPath = repo;
    this.state.projects = projects;
    this.state.unsupported = unsupported;
    this.state.languages = rankLanguages(projects);
    this.state.language = this.state.languages[0];
    this.state.projectRoot = this.defaultProjectRoot();
    await this.refreshSources();
    await this.refreshTools();
    this.state.branches = branches;
    this.state.baseBranch = branches.includes(base) ? base : branches[0];
    this.state.newBranch = defaultNewBranchName();
  }

  // Checks the tools and setup items the current language needs. Items marked autoRun (npm packages) install in the background first.
  // Branch creation and generation stay blocked while any required item is missing.
  private async refreshTools(): Promise<void> {
    const { repoPath, language, projects } = this.state;
    if (!repoPath || !language) return;
    const scoped = projects.filter(p => p.language === language);
    let tools = await checkTools(repoPath, scoped);
    const auto = tools.filter(t => t.autoRun && !t.ok && t.run);
    if (auto.length > 0) {
      try {
        for (const item of auto) {
          if (!item.run) continue;
          this.state.status = `Installing ${item.name}…`;
          this.post();
          await runSetup(item.run);
        }
      } catch (err) {
        this.state.error = err instanceof Error ? err.message : String(err);
      } finally {
        this.state.status = undefined;
      }
      tools = await checkTools(repoPath, scoped);
    }
    this.state.tools = tools;
  }

  // Runs the install command of one item the user allowed, then checks again.
  // A failed install usually needs administrator rights, so the user is told to ask an admin. A successful install needs a restart before the tool is on PATH.
  private async installTool(name: string): Promise<void> {
    const item = this.state.tools.find(t => t.name === name && t.run);
    if (!item?.run) throw new Error('Nothing to install for this item.');
    if (this.state.running) throw new Error('Wait for the current run to finish first.');
    this.state.status = `Installing ${item.name}…`;
    this.post();
    let failure: string | undefined;
    try {
      await runSetup(item.run);
    } catch (err) {
      failure = err instanceof Error ? err.message : String(err);
    } finally {
      this.state.status = undefined;
      await this.refreshTools();
    }
    const after = this.state.tools.find(t => t.name === name);
    if (failure) {
      this.state.error = `Could not install ${item.name}. This usually needs administrator rights. Contact your admin to install ${item.name}, then restart VS Code to continue.\n${failure}`;
    } else if (after && !after.ok) {
      this.state.error = `${item.name} was installed. Restart VS Code to continue, then click Recheck tools.`;
    }
  }

  private missingTools(): ToolCheck[] {
    return this.state.tools.filter(t => t.required && !t.ok);
  }

  // The projects of the chosen language.
  private languageProjects(): Project[] {
    return this.state.projects.filter(p => p.language === this.state.language);
  }

  // A language with one project uses it straight away. With several, the user picks one.
  private defaultProjectRoot(): string | undefined {
    const projects = this.languageProjects();
    return projects.length === 1 ? projects[0].root : undefined;
  }

  // Lists the source files of the chosen project. A new list clears any earlier selection.
  private async refreshSources(): Promise<void> {
    const { repoPath, projectRoot } = this.state;
    this.state.selected = [];
    this.state.choosing = false;
    if (!repoPath || projectRoot === undefined) {
      this.state.sourceFiles = [];
      return;
    }
    const all = this.languageProjects();
    const roots = all.map(p => p.root);
    const files = await listSourceFiles(repoPath, all);
    this.state.sourceFiles = files.filter(f => ownerOf(roots, f) === projectRoot);
  }

  // A folder value is a repo-relative path, or '' for the whole repository.
  private filesIn(folder: string): string[] {
    return this.state.sourceFiles.filter(f => folder === '' || f.startsWith(`${folder}/`));
  }

  // Lists the files that still need tests. A project with tests is measured first, so files at 100% coverage are left out.
  private async chooseFiles(): Promise<void> {
    const { repoPath, projectRoot } = this.state;
    const project = this.languageProjects().find(p => p.root === projectRoot);
    if (!repoPath || !project) throw new Error('Choose a project first.');
    if (project.hasTests) {
      const needed = await filesNeedingTests(repoPath, project, this.languageProjects());
      if (needed.length === 0) {
        throw new Error('Every source file in this project is already fully covered by its tests. Nothing to write.');
      }
      this.state.sourceFiles = needed;
    }
    this.state.selected = [];
    this.state.choosing = true;
  }

  private setSelected(files: string[], checked: boolean): void {
    const current = new Set(this.state.selected);
    for (const f of files) {
      if (checked) current.add(f);
      else current.delete(f);
    }
    this.state.selected = this.state.sourceFiles.filter(f => current.has(f));
  }

  // Tells the user what to install, with the same steps the checklist shows.
  private missingToolsError(missing: ToolCheck[]): string {
    return `Install the tools below first. ${missing.map(t => `${t.name}: ${t.hint}`).join('. ')}.`;
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
      unsupported: [],
      language: undefined,
      projectRoot: undefined,
      tools: [],
      branches: [],
      baseBranch: undefined,
      newBranch: undefined,
      branchReady: false,
      report: undefined,
      progress: undefined,
      sourceFiles: [],
      selected: [],
      choosing: false,
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

  private async start(selectedOnly: boolean): Promise<void> {
    const { repoPath, newBranch, language, branchReady, running, projectRoot } = this.state;
    if (running) return;
    if (!repoPath || !newBranch || !language || !branchReady) {
      throw new Error('Create the working branch before starting.');
    }
    const all = this.languageProjects();
    const project = all.find(p => p.root === projectRoot);
    if (!project) {
      throw new Error('Choose the project to write tests for first.');
    }
    const label = project.root || 'the repository root';
    if (!project.framework) {
      throw new Error(`Choose the test framework for ${label} first.`);
    }
    if (!project.testCommand?.trim()) {
      throw new Error(`Could not work out the test command for ${label}. Choose the framework again.`);
    }
    const selected = selectedOnly ? [...this.state.selected] : undefined;
    if (selected && selected.length === 0) {
      throw new Error('Tick at least one file or folder first.');
    }
    const missing = this.missingTools();
    if (missing.length > 0) {
      throw new Error(this.missingToolsError(missing));
    }

    this.state.running = true;
    this.state.report = undefined;
    this.cancelRequested = false;
    resetCopilotStop();
    this.post();
    try {
      this.state.report = await runGeneration(
        { repoPath, branch: newBranch, language, projects: [project], allRoots: all.map(p => p.root), selected },

        (progress: Progress) => {
          this.state.progress = progress;
          this.post();
        },
        () => this.cancelRequested,
      );
      await fs.mkdir(path.dirname(this.reportFile), { recursive: true });
      await writeReportFiles(this.state.report, repoPath, this.htmlFile, this.reportFile);
    } catch (err) {
      // A cancel stops the Copilot call and test commands mid-step, so their errors are expected. Anything else is a real failure.
      if (!this.cancelRequested) throw err;
      this.state.error = 'Test generation was cancelled. Tests already written stay on the branch.';
    } finally {
      this.state.running = false;
      this.state.status = undefined;
      resetCopilotStop();
    }
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
