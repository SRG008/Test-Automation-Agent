import { randomBytes } from 'crypto';

export function getHtml(cspSource: string): string {
  const nonce = randomBytes(16).toString('hex');
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); font-size: var(--vscode-font-size); padding: 12px; }
  h2 { font-size: 11px; text-transform: uppercase; letter-spacing: .05em; margin: 0 0 10px; opacity: .8; }
  p { margin: 6px 0 12px; line-height: 1.45; }
  .btn { display: block; width: 100%; box-sizing: border-box; padding: 6px 10px; margin: 8px 0; border: none; border-radius: 2px; cursor: pointer; text-align: center; font: inherit; background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  .btn:hover { background: var(--vscode-button-hoverBackground); }
  .btn.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  .btn:disabled { opacity: .5; cursor: default; }
  label { display: block; font-size: 12px; opacity: .85; margin-top: 10px; }
  select, input { width: 100%; box-sizing: border-box; margin: 4px 0 6px; padding: 4px; font: inherit; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, transparent); }
  .ok { color: var(--vscode-testing-iconPassed); }
  .fail { color: var(--vscode-testing-iconFailed); }
  .error { color: var(--vscode-errorForeground); margin: 8px 0; }
  .muted { font-size: 12px; opacity: .75; word-break: break-all; }
  .track { height: 6px; border-radius: 3px; overflow: hidden; margin: 8px 0; background: var(--vscode-editorWidget-border, #444); }
  .fill { height: 100%; background: var(--vscode-progressBar-background); transition: width .3s; }
  .step { margin: 5px 0; }
  .stat { display: flex; justify-content: space-between; font-size: 12px; margin: 4px 0; }
  .file { display: flex; justify-content: space-between; width: 100%; background: none; border: none; color: var(--vscode-textLink-foreground); cursor: pointer; padding: 3px 0; font: inherit; font-size: 12px; text-align: left; }
  .file:hover { text-decoration: underline; }
  hr { border: none; border-top: 1px solid var(--vscode-editorWidget-border, #444); margin: 14px 0; }
</style>
</head>
<body>
<div id="app"></div>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const app = document.getElementById('app');
  let state = null;

  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function send(type, extra) { vscode.postMessage(Object.assign({ type: type }, extra || {})); }
  function btn(label, action, cls) {
    return '<button class="btn ' + (cls || '') + '" data-action="' + action + '">' + esc(label) + '</button>';
  }
  function selectField(label, change, options, value) {
    var html = '<label>' + esc(label) + '</label><select data-change="' + change + '">';
    (options || []).forEach(function (o) {
      html += '<option value="' + esc(o) + '"' + (o === value ? ' selected' : '') + '>' + esc(o) + '</option>';
    });
    return html + '</select>';
  }
  function errorBlock() { return state.error ? '<div class="error">' + esc(state.error) + '</div>' : ''; }
  function connectedLine() {
    return '<p class="ok">✓ Connected to Copilot' + (state.model ? ' (' + esc(state.model) + ')' : '') + '</p>';
  }
  function repoLine() { return '<p class="muted">Repository: ' + esc(state.repoPath) + '</p>'; }

  function renderConnect() {
    return '<h2>Auto Tests</h2>'
      + '<p>Generate unit tests in the background using your GitHub Copilot.</p>'
      + btn('Connect to Copilot', 'connect')
      + errorBlock();
  }
  function renderRepo() {
    return '<h2>Auto Tests</h2>' + connectedLine()
      + '<p>Select the cloned repository folder to continue.</p>'
      + btn('Select Repository Folder', 'selectFolder')
      + errorBlock();
  }
  function renderBranch() {
    var langField = state.languages.length > 1
      ? selectField('Language', 'setLanguage', state.languages, state.language)
      : '<p class="muted">Language: ' + esc(state.language) + '</p>';
    return '<h2>Auto Tests</h2>' + connectedLine() + repoLine() + '<hr>'
      + langField
      + selectField('Test framework', 'setFramework', state.frameworks, state.framework)
      + selectField('Base branch', 'setBaseBranch', state.branches, state.baseBranch)
      + '<label>New branch name</label><input data-change="setNewBranch" value="' + esc(state.newBranch) + '">'
      + btn('Pull Latest & Create Branch', 'createBranch')
      + btn('Change Repository', 'changeRepo', 'secondary')
      + errorBlock();
  }
  function renderReady() {
    return '<h2>Auto Tests</h2>' + connectedLine() + repoLine() + '<hr>'
      + '<p class="ok">✓ Created branch <b>' + esc(state.newBranch) + '</b></p>'
      + '<p class="muted">From latest ' + esc(state.baseBranch) + ' · ' + esc(state.framework) + '</p>'
      + btn('▶ Start Test Generation', 'start')
      + btn('Change Repository', 'changeRepo', 'secondary')
      + errorBlock();
  }
  function renderRunning() {
    var p = state.progress || { steps: [], done: 0, total: 1 };
    var pct = p.total ? Math.round((p.done / p.total) * 100) : 0;
    var steps = p.steps.map(function (s) {
      var icon = s.status === 'done' ? '<span class="ok">✓</span>' : (s.status === 'active' ? '●' : '○');
      return '<div class="step">' + icon + ' ' + esc(s.label) + '</div>';
    }).join('');
    return '<h2>Running in background</h2>'
      + '<p class="muted">Branch: ' + esc(state.newBranch) + '</p>'
      + '<div class="track"><div class="fill" style="width:' + pct + '%"></div></div>'
      + '<p class="muted">' + pct + '% complete</p>'
      + steps
      + btn('Cancel', 'cancel', 'secondary')
      + errorBlock();
  }
  function renderDone() {
    var r = state.report;
    var total = r.testsPassed + r.testsFailed;
    var files = r.files.length
      ? r.files.map(function (f) {
          var result = f.failed
            ? '<span class="fail">✗ ' + f.failed + ' failed</span>'
            : '<span class="ok">✓ ' + f.passed + ' passed</span>';
          return '<button class="file" data-open="' + esc(f.path) + '"><span>' + esc(f.path) + '</span>' + result + '</button>';
        }).join('')
      : '<p class="muted">No test files written.</p>';
    return '<h2>Completed</h2>'
      + '<p class="ok">✓ Completed on <b>' + esc(r.branch) + '</b></p>'
      + '<div class="stat"><span>Files written</span><span>' + r.filesWritten + '</span></div>'
      + '<div class="stat"><span>Tests passed</span><span>' + r.testsPassed + ' / ' + total + '</span></div>'
      + '<div class="stat"><span>Coverage</span><span>' + r.coverageBefore + '% → ' + r.coverageAfter + '%</span></div>'
      + '<div class="stat"><span>Skipped</span><span>' + r.skipped + '</span></div>'
      + btn('View Full Report', 'openReport')
      + btn('Run Again', 'start', 'secondary')
      + btn('Change Repository', 'changeRepo', 'secondary')
      + '<hr><h2>Files</h2>' + files
      + errorBlock();
  }

  function render() {
    var views = { connect: renderConnect, repo: renderRepo, branch: renderBranch, ready: renderReady, running: renderRunning, done: renderDone };
    app.innerHTML = (views[state.stage] || renderConnect)();
  }

  window.addEventListener('message', function (e) {
    if (e.data && e.data.type === 'state') {
      state = e.data.state;
      render();
    }
  });
  app.addEventListener('click', function (e) {
    var action = e.target.closest('[data-action]');
    if (action && !action.disabled) { send(action.dataset.action); return; }
    var file = e.target.closest('[data-open]');
    if (file) send('openFile', { value: file.dataset.open });
  });
  app.addEventListener('change', function (e) {
    var t = e.target;
    if (t.dataset && t.dataset.change) send(t.dataset.change, { value: t.value });
  });
</script>
</body>
</html>`;
}
