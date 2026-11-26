# Test Automation Agent

An automated unit test writing app for VS Code. It connects to your GitHub Copilot, analyzes your whole repository, and writes unit tests for you on a new branch.

## How it works

1. **Open the app** from the sidebar icon, then click **Connect to Copilot & Analyze**. It connects to Copilot and analyzes the entire repository.
2. **Language detection.** It identifies the language of your project, for example Node.js or .NET.
3. **Test framework.** If your project already has tests, it uses the framework they use. If not, it asks you to choose a test framework.
4. **Branch.** Choose the branch to start from, for example `develop`. The app pulls the latest version and creates a new branch from it.
5. **Coverage.** It analyzes the current test coverage.
6. **Generate.** Choose one of two options:
   - **Create test cases for all files** for every file.
   - **Choose files and folders** and generate test cases only for the ones you pick.
7. **Report.** When generation finishes, you get a coverage report.
