import * as vscode from 'vscode';

// Requests in flight, so a cancel can stop them instead of waiting for the reply.
const inFlight = new Set<vscode.CancellationTokenSource>();
let stopping = false;

// Cancels all Copilot requests in flight and refuses new ones until resetCopilotStop is called.
export function stopCopilotRequests(): void {
  stopping = true;
  for (const cts of inFlight) cts.cancel();
}

export function resetCopilotStop(): void {
  stopping = false;
}

// Sends one prompt to the signed-in Copilot model and returns the full text reply.
export async function askCopilot(prompt: string): Promise<string> {
  if (stopping) throw new Error('Run cancelled.');
  const [model] = await vscode.lm.selectChatModels({ vendor: 'copilot' });
  if (!model) {
    throw new Error('No Copilot model found. Sign in to GitHub Copilot in VS Code, then try again.');
  }
  const cts = new vscode.CancellationTokenSource();
  inFlight.add(cts);
  try {
    const response = await model.sendRequest([vscode.LanguageModelChatMessage.User(prompt)], {}, cts.token);
    let text = '';
    for await (const chunk of response.text) {
      text += chunk;
    }
    return text;
  } finally {
    inFlight.delete(cts);
    cts.dispose();
  }
}

// Returns the first fenced code block, or the whole reply if the model did not use one.
export function extractCode(reply: string): string {
  const match = /```[\w+-]*\n([\s\S]*?)```/.exec(reply);
  return (match ? match[1] : reply).trim() + '\n';
}
