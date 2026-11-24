# Auto Unit Test Agent

A VS Code extension with its own sidebar icon. It connects to your signed-in GitHub Copilot, takes a cloned repository, creates a fresh branch from the latest base branch, and generates unit tests in the background on that branch.

## Flow

1. **Connect to Copilot** uses the model you're signed in to through the VS Code Language Model API.
2. **Select Repository Folder** accepts only git repositories. Languages and test frameworks are detected from the repo root.
3. Choose the base branch and framework, then **Pull Latest & Create Branch**. A dirty working tree stops here; local work is never stashed or discarded.
4. **Start Test Generation** runs in the background. Progress shows in the sidebar.
5. **Completed** shows the summary, a file list (click to open), and **View Full Report**.

## Status

This is a scaffold:
- Connect, repository selection, language and framework detection, branch sync, progress UI, and the report view are implemented.
- The test engine in [src/testRunner.ts](src/testRunner.ts) is a placeholder. It walks the progress steps without calling Copilot or writing files. The next step is replacing it with the function-level Copilot generation, test running, and coverage measurement.

## Run locally

```powershell
npm install
npm run compile
```

Then press F5 in VS Code to launch an Extension Development Host.

## Package

Run these after each code change. Each run bumps the patch version in `package.json` and writes a new `auto-unit-test-agent-<version>.vsix` file.

```powershell
npm install
npm run compile
npx @vscode/vsce package patch --no-git-tag-version
```

To install the `.vsix` locally, run **Extensions: Install from VSIX** in VS Code, or `code --install-extension <file>.vsix`. A higher version replaces the installed one.
