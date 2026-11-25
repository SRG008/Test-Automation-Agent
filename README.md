# Test Automation Agent

A VS Code extension with its own sidebar icon. It connects to your signed-in GitHub Copilot, uses the git repository open in VS Code, creates a fresh branch from the latest version of a base branch you choose, and generates unit tests in the background on that branch.

## Flow

1. **Connect to Copilot** uses the model you're signed in to through the VS Code Language Model API.
2. The repository is the git repo of the folder open in VS Code (File > Open Folder). Nothing is picked in the sidebar. Every project is found at any depth (monorepos included), and languages are ranked with the ones that already have tests first.
3. If an existing project already has tests, its framework is read from them and no choice is asked. Otherwise, choose a framework from the list (only frameworks the agent can set up and run). The sidebar then checks the tools the language needs by running a real command for each (for example `node`, `npm`, Python plus `pip`, `dotnet --list-sdks`, `go env GOROOT`, or a JDK with Maven or Gradle). Each missing tool shows its install link and what to do next. Branch creation and Start stay blocked until the required tools pass; restart VS Code after installing, then press **Recheck tools**. The chosen test framework is shown as already in the project or as "will be installed when you press Start", and it does not block. Maven and Gradle wrappers (`mvnw`, `gradlew`) count as installed. Choose the base branch from the dropdown (it defaults to the checked-out branch). **Pull Latest & Create Branch** pulls that branch from origin and creates the new branch on top of it. A dirty working tree stops here; local work is never stashed or discarded.
4. **Start Test Generation** measures line coverage across the whole codebase first. It lists the covered and uncovered lines and files, then writes or extends tests for the uncovered lines, and measures again. Progress shows in the sidebar.
5. While a step runs, the sidebar shows a spinner, the elapsed time, and an estimated time left. Button actions such as Connect to Copilot show a blurred overlay with a loader until the sidebar updates.
6. **Completed** shows the before and after coverage, files fully covered, the test case names written per file, a file list (click to open), and **View HTML Report** and **View PDF Report**. **Save PDF…** copies the report to a location you choose. The HTML and PDF reports are stored in the extension's storage folder and overwritten on each run, so no Markdown report is kept.
   - The report has a ReportGenerator-style layout for every language: summary cards for lines, branches, and methods (branches and methods show n/a when not measured), a source page list with per-file coverage bars, and a risk hotspot list of files with the most uncovered lines.

## Status

Implemented:
- Connect, repository selection, language and framework detection, branch sync, progress UI, and the PDF report.
- The test engine in [src/testRunner.ts](src/testRunner.ts) finds source functions that no test refers to, asks Copilot for tests, runs them, and makes up to 3 fix attempts per file. A file that still fails is reverted and reported as skipped.
- Test locations and naming follow the repo's existing layout. Missing test projects are created, and existing test files are extended. Language rules live in [src/languages/adapters.ts](src/languages/adapters.ts).
- Python tests run with the project's `.venv` or `venv` when one exists, so the project's dependencies are importable. pytest is installed into that environment if missing. Otherwise the system Python is used.
- Supported: Python (pytest or unittest), TypeScript/JavaScript (Vitest, Jest, or Mocha), Go (go test), Java (JUnit 5 or TestNG, with Maven or Gradle), and C# (xUnit, NUnit, or MSTest; a `<Project>.Tests` project is created if none exists).
- The framework dropdown lists every framework for the detected language. If the chosen one is not set up yet, the agent installs it: npm packages (plus ts-jest or ts-node where needed, and a `jest.config.js` if none exists), Maven or Gradle test dependencies, or NuGet packages via `dotnet`. If the repo already has tests, their framework is used and the dropdown is skipped.

Limits:
- Coverage is real line coverage for Python (`coverage`, with branch data), TypeScript/JavaScript with Jest or Vitest (with branch and method data), Go, C# (Coverlet, with branch and method data), and Java (JaCoCo). The agent installs the missing tool into the project: `coverage` into the Python environment, `@vitest/coverage-v8` for Vitest, and `coverlet.collector` into each C# test project. Jest and Go need nothing extra.
- Java: on first run the agent adds the JaCoCo plugin to the top-level `<build><plugins>` of each `pom.xml`, or applies JaCoCo through an init script for Gradle, so no project files are edited by hand. Java line, branch, and method data come from the JaCoCo XML report.
- Mocha has no line coverage yet. It falls back to name-based coverage, where a function counts as covered when a test file mentions its name.
- npm installs try the normal install first. If npm reports an `ERESOLVE` peer-dependency conflict (for example, an existing `@types/node` version that a new tool does not accept), the agent retries that one install with `--legacy-peer-deps`. This keeps the install going but can leave the dependency tree with peer warnings, so review `package.json` and `package-lock.json` afterwards.
- When an install fails (pip, npm, or `dotnet`), the agent shows the tool's error lines and the exact command to run by hand. It does not retry other failures automatically.
- Coverage runs the project's full test suite before and after generation, so large repositories take longer.
- Each project is handled in its own folder. A source file belongs to the deepest project above it.
- C# test projects are created inside the source project's folder and excluded from its compilation. Existing test projects elsewhere are not detected.
- Java support is not yet verified end to end (no JDK or Maven was available during development). Maven projects on an old Surefire version may not run JUnit 5 tests. The JaCoCo path is also unverified; Gradle projects need Gradle 8 or later for the init script.
- Java multi-module projects are only partly handled: source files outside `src/main/java` are not measured.
- Mocha has no coverage support here, so its coverage is name-based rather than line-based.
- The report layout has been checked only with a standalone render, not in VS Code. The PDF uses standard fonts, so characters outside Latin text may not display.
- Framework setup for TypeScript, Java, and C# has been compiled but not run against real repositories.
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
