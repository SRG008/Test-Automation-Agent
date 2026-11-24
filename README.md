# Auto Unit Test Agent

A VS Code extension with its own sidebar icon. It connects to your signed-in GitHub Copilot, takes a cloned repository, creates a fresh branch from the latest base branch, and generates unit tests in the background on that branch.

## Flow

1. **Connect to Copilot** uses the model you're signed in to through the VS Code Language Model API.
2. **Select Repository Folder** accepts only git repositories. Every project is found at any depth (monorepos included), and languages are ranked with the ones that already have tests first.
3. If an existing project already has tests, its framework is read from them and no choice is asked. Otherwise, choose a framework from the list (only frameworks the agent can set up and run). Then choose the base branch and **Pull Latest & Create Branch**. A dirty working tree stops here; local work is never stashed or discarded.
4. **Start Test Generation** runs in the background. Progress shows in the sidebar.
5. **Completed** shows the summary, a file list (click to open), and **View Full Report**.

## Status

Implemented:
- Connect, repository selection, language and framework detection, branch sync, progress UI, and the report view.
- The test engine in [src/testRunner.ts](src/testRunner.ts) finds source functions that no test refers to, asks Copilot for tests, runs them, and makes up to 3 fix attempts per file. A file that still fails is reverted and reported as skipped.
- Test locations and naming follow the repo's existing layout. Missing test projects are created, and existing test files are extended. Language rules live in [src/languages/adapters.ts](src/languages/adapters.ts).
- Python tests run with the project's `.venv` or `venv` when one exists, so the project's dependencies are importable. pytest is installed into that environment if missing. Otherwise the system Python is used.
- Supported: Python (pytest or unittest), TypeScript/JavaScript (Vitest is installed automatically if missing; Jest and Mocha must already be set up), Go, Java (JUnit 5 with Maven or Gradle), and C# (xUnit; a `<Project>.Tests` project is created if none exists).

Limits:
- Coverage is name-based: a function counts as covered when a test file mentions its name. It is not line coverage.
- Each project is handled in its own folder. A source file belongs to the deepest project above it.
- C# test projects are created inside the source project's folder and excluded from its compilation. Existing test projects elsewhere are not detected.
- Java support is not yet verified end to end (no JDK or Maven was available during development).
- Source files are never changed. Tests are only written and verified, so review the generated tests before merging.

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
