import * as vscode from 'vscode';
import { AutoTestsViewProvider } from './sidebarProvider';

export function activate(context: vscode.ExtensionContext): void {
  const provider = new AutoTestsViewProvider();
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(AutoTestsViewProvider.viewType, provider, {
      // Keeps the progress view state while the sidebar is hidden during a background run.
      webviewOptions: { retainContextWhenHidden: true },
    }),
  );
}

export function deactivate(): void {}
