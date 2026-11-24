import * as vscode from 'vscode';

// Sends one prompt to the signed-in Copilot model and returns the full text reply.
export async function askCopilot(prompt: string): Promise<string> {
  const [model] = await vscode.lm.selectChatModels({ vendor: 'copilot' });
  if (!model) {
    throw new Error('No Copilot model found. Sign in to GitHub Copilot in VS Code, then try again.');
  }
  const cts = new vscode.CancellationTokenSource();
  const response = await model.sendRequest([vscode.LanguageModelChatMessage.User(prompt)], {}, cts.token);
  let text = '';
  for await (const chunk of response.text) {
    text += chunk;
  }
  cts.dispose();
  return text;
}

// Returns the first fenced code block, or the whole reply if the model did not use one.
export function extractCode(reply: string): string {
  const match = /```[\w+-]*\n([\s\S]*?)```/.exec(reply);
  return (match ? match[1] : reply).trim() + '\n';
}
