import { execFile } from 'child_process';
import { promisify } from 'util';

const run = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await run('git', args, { cwd, windowsHide: true, maxBuffer: 10 * 1024 * 1024 });
  return stdout.trim();
}

export async function isGitRepo(repo: string): Promise<boolean> {
  try {
    return (await git(repo, ['rev-parse', '--is-inside-work-tree'])) === 'true';
  } catch {
    return false;
  }
}

async function hasOrigin(repo: string): Promise<boolean> {
  return (await git(repo, ['remote'])).split('\n').includes('origin');
}

// Repo-relative paths of tracked files; ignored and untracked files are left out.
export async function trackedFiles(repo: string): Promise<string[]> {
  const out = await git(repo, ['ls-files']);
  return out ? out.split('\n') : [];
}

// The git repository root that contains the given folder.
export async function repoRoot(folder: string): Promise<string> {
  return git(folder, ['rev-parse', '--show-toplevel']);
}

// The checked-out branch, or undefined when HEAD is detached.
export async function currentBranch(repo: string): Promise<string | undefined> {
  return (await git(repo, ['branch', '--show-current'])) || undefined;
}

export async function isWorkingTreeClean(repo: string): Promise<boolean> {
  return (await git(repo, ['status', '--porcelain'])) === '';
}

export async function listBranches(repo: string): Promise<string[]> {
  const out = await git(repo, ['for-each-ref', '--format=%(refname:short)', 'refs/heads', 'refs/remotes/origin']);
  const names = out
    .split('\n')
    .map(s => s.trim())
    .filter(n => n && n !== 'origin' && n !== 'HEAD')
    .map(n => n.replace(/^origin\//, ''));
  return [...new Set(names)].sort();
}

// Pulls the latest of the chosen base branch from origin, then creates the new branch on top of it.
// Never stashes or discards local work: a dirty tree stops the operation.
export async function createBranchFromLatest(repo: string, base: string, newBranch: string): Promise<void> {
  if (!(await isWorkingTreeClean(repo))) {
    throw new Error('Uncommitted changes found. Commit or stash them, then try again.');
  }
  if (await git(repo, ['branch', '--list', newBranch])) {
    throw new Error(`Branch "${newBranch}" already exists.`);
  }

  await git(repo, ['checkout', base]);
  if (await hasOrigin(repo)) {
    await git(repo, ['fetch', 'origin', base]);
    await git(repo, ['pull', '--ff-only', 'origin', base]);
  }
  await git(repo, ['checkout', '-b', newBranch]);
}
