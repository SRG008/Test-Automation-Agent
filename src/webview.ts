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
  .fill { height: 100%; background: linear-gradient(90deg, #22d3ee, #a855f7, #f472b6, #22d3ee); background-size: 200% 100%; transition: width .3s; animation: flow 2s linear infinite; }
  @keyframes flow { from { background-position: 0 0; } to { background-position: 200% 0; } }
  .spinner { display: inline-block; width: 10px; height: 10px; margin-right: 4px; vertical-align: -1px; border: 2px solid rgba(168, 85, 247, .3); border-top-color: #a855f7; border-radius: 50%; animation: spin .8s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  .timing { font-size: 12px; margin: 6px 0 10px; line-height: 1.6; }
  .busy { position: fixed; inset: 0; z-index: 10; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 14px; background: rgba(0, 0, 0, .28); backdrop-filter: blur(4px); -webkit-backdrop-filter: blur(4px); }
  .busy[hidden] { display: none; }
  .beaker svg { width: 72px; height: 72px; animation: bob 1.8s ease-in-out infinite; }
  @keyframes bob { 0%, 100% { transform: rotate(-4deg); } 50% { transform: rotate(4deg); } }
  .liquid { animation: slosh 2.2s ease-in-out infinite alternate; }
  @keyframes slosh { from { transform: translateY(2px); } to { transform: translateY(-2px); } }
  .bub { opacity: 0; animation: rise 1.6s ease-in infinite; }
  .b2 { animation-delay: .5s; }
  .b3 { animation-delay: 1s; }
  @keyframes rise { 0% { transform: translateY(0); opacity: 0; } 20% { opacity: .9; } 100% { transform: translateY(-16px); opacity: 0; } }
  .busy-bar { width: 160px; height: 6px; border-radius: 3px; overflow: hidden; background: rgba(255, 255, 255, .2); }
  .sweep { width: 40%; height: 100%; background: linear-gradient(90deg, #22d3ee, #a855f7, #f472b6); animation: sweep 1.4s ease-in-out infinite; }
  @keyframes sweep { from { transform: translateX(-100%); } to { transform: translateX(260%); } }
  .busy-text { font-size: 13px; font-weight: 600; color: var(--vscode-foreground); }
  .step { margin: 5px 0; }
  .now { border: 1px solid var(--vscode-editorWidget-border, #444); border-left: 3px solid #a855f7; border-radius: 4px; padding: 6px 8px; margin: 8px 0; font-size: 12px; }
  .now-head { font-weight: 600; }
  .now-file { word-break: break-all; margin: 2px 0 4px; }
  .tests { margin: 4px 0 0; padding-left: 16px; }
  .tests li { margin: 2px 0; word-break: break-word; }
  .stat { display: flex; justify-content: space-between; font-size: 12px; margin: 4px 0; }
  .file { display: flex; justify-content: space-between; width: 100%; background: none; border: none; color: var(--vscode-textLink-foreground); cursor: pointer; padding: 3px 0; font: inherit; font-size: 12px; text-align: left; }
  .file:hover { text-decoration: underline; }
  hr { border: none; border-top: 1px solid var(--vscode-editorWidget-border, #444); margin: 14px 0; }
</style>
</head>
<body>
<div id="app"></div>
<div id="busy" class="busy" hidden>
  <div class="beaker">
    <svg viewBox="0 0 64 64" aria-hidden="true">
      <defs>
        <linearGradient id="liquid" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stop-color="#22d3ee"/>
          <stop offset="0.55" stop-color="#a855f7"/>
          <stop offset="1" stop-color="#f472b6"/>
        </linearGradient>
        <clipPath id="flask"><path d="M24 6h16v14l12 22a6 6 0 0 1-5 9H17a6 6 0 0 1-5-9l12-22z"/></clipPath>
      </defs>
      <g clip-path="url(#flask)"><rect class="liquid" x="0" y="34" width="64" height="40" fill="url(#liquid)"/></g>
      <circle class="bub" cx="27" cy="46" r="2.5" fill="#ffffff"/>
      <circle class="bub b2" cx="36" cy="50" r="2" fill="#ffffff"/>
      <circle class="bub b3" cx="32" cy="42" r="1.5" fill="#ffffff"/>
      <path d="M24 6h16v14l12 22a6 6 0 0 1-5 9H17a6 6 0 0 1-5-9l12-22z" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linejoin="round"/>
      <path d="M22 6h20" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/>
    </svg>
  </div>
  <div class="busy-bar"><div class="sweep"></div></div>
  <div id="busy-text" class="busy-text"></div>
</div>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const app = document.getElementById('app');
  const busy = document.getElementById('busy');
  const busyText = document.getElementById('busy-text');
  let state = null;

  // Text shown over the blurred background while the host works on an action.
  const BUSY = {
    connect: 'Connecting to Copilot…',
    createBranch: 'Pulling latest and creating branch…',
    recheckTools: 'Checking tools…',
    setLanguage: 'Checking tools…',
    setFramework: 'Checking tools…',
    start: 'Starting test generation…',
    openReport: 'Opening PDF report…',
    openHtml: 'Opening HTML report…',
    savePdf: 'Saving PDF report…',
  };
  function showBusy(action) {
    if (!BUSY[action]) return;
    busyText.textContent = BUSY[action];
    busy.hidden = false;
  }
  // Any state message from the host means the action has finished.
  function hideBusy() { busy.hidden = true; }

  function fmt(sec) {
    sec = Math.max(0, Math.round(sec));
    var m = Math.floor(sec / 60);
    var s = sec % 60;
    return m ? m + 'm ' + s + 's' : s + 's';
  }
  // Updates the elapsed time and the estimated time left once a second while a run is going.
  function updateTimers() {
    if (!state || state.stage !== 'running' || !state.progress) return;
    var p = state.progress;
    var now = Date.now();
    var elapsed = document.getElementById('elapsed');
    var eta = document.getElementById('eta');
    if (elapsed) elapsed.textContent = fmt((now - p.startedAt) / 1000);
    if (eta) {
      var remaining = 0;
      var active = null;
      p.steps.forEach(function (s) {
        if (s.status !== 'done') remaining += s.estimateSec;
        if (s.status === 'active') active = s;
      });
      if (active && active.startedAt) remaining -= (now - active.startedAt) / 1000;
      eta.textContent = remaining > 0 ? '~' + fmt(remaining) : 'longer than estimated';
    }
  }
  setInterval(updateTimers, 1000);

  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function send(type, extra) { vscode.postMessage(Object.assign({ type: type }, extra || {})); }
  function btn(label, action, cls) {
    return '<button class="btn ' + (cls || '') + '" data-action="' + action + '">' + esc(label) + '</button>';
  }
  function covText(s) {
    return (s.total === 0 ? 100 : Math.round(s.covered / s.total * 100)) + '% (' + s.covered + '/' + s.total + ')';
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
  function missingNames() {
    return (state.tools || []).filter(function (t) { return t.required && !t.ok; }).map(function (t) { return t.name; });
  }
  function toolsBlock() {
    var tools = state.tools || [];
    if (tools.length === 0) return '';
    var rows = tools.map(function (t) {
      if (!t.required) {
        // Framework rows are informational: a missing one is installed on Start.
        var mark = t.ok ? '<span class="ok">✓</span>' : '<span class="muted">○</span>';
        var text = t.ok ? '' : ' <span class="muted">' + esc(t.hint) + '</span>';
        return '<div class="step">' + mark + ' ' + esc(t.name) + text + '</div>';
      }
      var status = t.ok ? '<span class="ok">✓</span>' : '<span class="fail">✗</span>';
      var help = t.ok ? '' : ' <button class="btn secondary" data-url="' + esc(t.url) + '">' + esc(t.hint) + '</button>';
      return '<div class="step">' + status + ' ' + esc(t.name) + help + '</div>';
    }).join('');
    return '<p class="muted">Required tools for ' + esc(state.language) + '</p>' + rows;
  }
  function installNote() {
    var missing = missingNames();
    return missing.length
      ? '<p class="muted">Install the tools marked ✗ to continue. Each button opens its download page. Restart VS Code after installing, then click Recheck tools.</p>'
      : '';
  }
  // Shows Recheck tools in place of the action while a required tool is missing.
  function gateButton(label, action) {
    return missingNames().length ? btn('Recheck tools', 'recheckTools', 'secondary') : btn(label, action);
  }

  function renderConnect() {
    return '<h2>Auto Tests</h2>'
      + '<p>Generate unit tests in the background using your GitHub Copilot.</p>'
      + btn('Connect to Copilot', 'connect')
      + errorBlock();
  }
  function renderRepo() {
    return '<h2>Auto Tests</h2>' + connectedLine()
      + '<p>Open the repository in VS Code (File &gt; Open Folder), then press Retry.</p>'
      + btn('Retry', 'connect')
      + errorBlock();
  }
  function frameworkText() {
    return state.frameworkNeeded ? state.framework : (state.detectedFrameworks || []).join(', ');
  }
  function renderBranch() {
    var langField = state.languages.length > 1
      ? selectField('Language', 'setLanguage', state.languages, state.language)
      : '<p class="muted">Language: ' + esc(state.language) + '</p>';
    if (missingNames().length > 0) {
      return '<h2>Auto Tests</h2>' + connectedLine() + repoLine() + '<hr>'
        + langField
        + toolsBlock()
        + installNote()
        + btn('Recheck tools', 'recheckTools', 'secondary')
        + errorBlock();
    }
    var fwField = state.frameworkNeeded
      ? selectField('Test framework', 'setFramework', state.frameworks, state.framework)
      : '<p class="muted">Existing tests use: ' + esc(frameworkText()) + '</p>';
    return '<h2>Auto Tests</h2>' + connectedLine() + repoLine() + '<hr>'
      + langField
      + fwField
      + toolsBlock()
      + '<p class="muted">Pulls the latest of the base branch, then creates the new branch on top of it.</p>'
      + selectField('Base branch', 'setBaseBranch', state.branches, state.baseBranch)
      + '<label>New branch name</label><input data-change="setNewBranch" value="' + esc(state.newBranch) + '">'
      + btn('Pull Latest & Create Branch', 'createBranch')
      + errorBlock();
  }
  function renderReady() {
    return '<h2>Auto Tests</h2>' + connectedLine() + repoLine() + '<hr>'
      + '<p class="ok">✓ Created branch <b>' + esc(state.newBranch) + '</b></p>'
      + '<p class="muted">From latest ' + esc(state.baseBranch) + ' · ' + esc(frameworkText()) + '</p>'
      + toolsBlock()
      + installNote()
      + gateButton('▶ Start Test Generation', 'start')
      + errorBlock();
  }
  function renderRunning() {
    var p = state.progress || { steps: [], done: 0, total: 1, startedAt: Date.now() };
    var pct = p.total ? Math.round((p.done / p.total) * 100) : 0;
    var steps = p.steps.map(function (s) {
      var icon = s.status === 'done' ? '<span class="ok">✓</span>' : (s.status === 'active' ? '<span class="spinner"></span>' : '○');
      return '<div class="step">' + icon + ' ' + esc(s.label) + '</div>';
    }).join('');
    var live = p.live;
    var LIST_LIMIT = 12;
    var liveBlock = '';
    if (live) {
      var shown = live.tests.slice(0, LIST_LIMIT).map(function (t) { return '<li>' + esc(t) + '</li>'; }).join('');
      var more = live.tests.length > LIST_LIMIT ? '<li class="muted">+' + (live.tests.length - LIST_LIMIT) + ' more</li>' : '';
      liveBlock = '<div class="now">'
        + '<div class="now-head">Covering file ' + live.index + ' of ' + live.total + '</div>'
        + '<div class="now-file">' + esc(live.file) + '</div>'
        + '<div class="muted"><span class="spinner"></span> ' + esc(live.phase) + '</div>'
        + (live.tests.length
          ? '<div class="muted">Test cases in this file: ' + live.tests.length + '</div><ul class="tests">' + shown + more + '</ul>'
          : '')
        + '</div>';
    }
    return '<h2>Running in background</h2>'
      + '<p class="muted">Branch: ' + esc(state.newBranch) + '</p>'
      + '<div class="track"><div class="fill" style="width:' + pct + '%"></div></div>'
      + '<p class="muted">' + pct + '% complete</p>'
      + '<div class="timing">Elapsed: <b id="elapsed">0s</b><br>Estimated time left: <b id="eta">…</b></div>'
      + liveBlock
      + steps
      + btn('Cancel', 'cancel', 'secondary')
      + errorBlock();
  }
  function renderDone() {
    var r = state.report;
    var files = r.files.length
      ? r.files.map(function (f) {
          var result = f.status === 'written'
            ? '<span class="ok">✓ written</span>'
            : '<span class="fail">✗ skipped</span>';
          return '<button class="file" data-open="' + esc(f.path) + '"><span>' + esc(f.path) + '</span>' + result + '</button>';
        }).join('')
      : '<p class="muted">No test files written.</p>';
    return '<h2>Completed</h2>'
      + '<p class="ok">✓ Completed on <b>' + esc(r.branch) + '</b></p>'
      + '<div class="stat"><span>Files written</span><span>' + r.filesWritten + '</span></div>'
      + '<div class="stat"><span>Files skipped</span><span>' + r.filesSkipped + '</span></div>'
      + '<div class="stat"><span>' + (r.coverageAfter.unit === 'lines' ? 'Line coverage' : 'Function coverage') + '</span><span>' + covText(r.coverageBefore) + ' → ' + covText(r.coverageAfter) + '</span></div>'
      + '<div class="stat"><span>Files fully covered</span><span>' + r.coverageBefore.filesCovered + '/' + r.coverageBefore.filesTotal + ' → ' + r.coverageAfter.filesCovered + '/' + r.coverageAfter.filesTotal + '</span></div>'
      + btn('View PDF Report', 'openReport')
      + btn('View HTML Report', 'openHtml', 'secondary')
      + btn('Save PDF…', 'savePdf', 'secondary')
      + btn('Run Again', 'start', 'secondary')
      + '<hr><h2>Files</h2>' + files
      + errorBlock();
  }

  function render() {
    var views = { connect: renderConnect, repo: renderRepo, branch: renderBranch, ready: renderReady, running: renderRunning, done: renderDone };
    app.innerHTML = (views[state.stage] || renderConnect)();
    updateTimers();
  }

  window.addEventListener('message', function (e) {
    if (e.data && e.data.type === 'state') {
      state = e.data.state;
      hideBusy();
      render();
    }
  });
  app.addEventListener('click', function (e) {
    var action = e.target.closest('[data-action]');
    if (action && !action.disabled) { showBusy(action.dataset.action); send(action.dataset.action); return; }
    var link = e.target.closest('[data-url]');
    if (link) { send('openUrl', { value: link.dataset.url }); return; }
    var file = e.target.closest('[data-open]');
    if (file) send('openFile', { value: file.dataset.open });
  });
  app.addEventListener('change', function (e) {
    var t = e.target;
    if (t.dataset && t.dataset.change) { showBusy(t.dataset.change); send(t.dataset.change, { value: t.value }); }
  });
</script>
</body>
</html>`;
}
