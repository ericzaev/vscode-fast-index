import * as vscode from 'vscode';
import * as fs from 'fs';
import { ProjectIndexer } from './indexer';

export class SidebarProvider implements vscode.WebviewViewProvider {
    private _view?: vscode.WebviewView;

    constructor(
        private readonly _extensionUri: vscode.Uri,
        private readonly indexer: ProjectIndexer
    ) {}

    public resolveWebviewView(webviewView: vscode.WebviewView) {
        this._view = webviewView;
        webviewView.webview.options = { enableScripts: true, localResourceRoots: [this._extensionUri] };
        webviewView.webview.html = this._getHtmlForWebview();

        webviewView.webview.onDidReceiveMessage(async (data) => {
            switch (data.type) {
                case 'search': {
                    const { value, isMatchCase, isRegex } = data;
                    if (!value || (!isRegex && value.length < 3)) {
                        this._view?.webview.postMessage({ type: 'results', value: [] });
                        return;
                    }
                    const files = this.indexer.search(value, isRegex);
                    const snippets = await this.getSnippets(files, value, isMatchCase, isRegex);
                    this._view?.webview.postMessage({ type: 'results', value: snippets });
                    break;
                }
                case 'replaceSingle': {
                    const { file, line, query, replaceText, isMatchCase, isRegex } = data.value;
                    await this.replaceInFile(file, line, query, replaceText, isMatchCase, isRegex);
                    const files = this.indexer.search(query, isRegex);
                    const snippets = await this.getSnippets(files, query, isMatchCase, isRegex);
                    this._view?.webview.postMessage({ type: 'results', value: snippets });
                    break;
                }
                case 'replaceAll': {
                    const { results, query, replaceText, isMatchCase, isRegex } = data.value;
                    await this.replaceAllInFiles(results, query, replaceText, isMatchCase, isRegex);
                    const files = this.indexer.search(query, isRegex);
                    const snippets = await this.getSnippets(files, query, isMatchCase, isRegex);
                    this._view?.webview.postMessage({ type: 'results', value: snippets });
                    break;
                }
                case 'rebuildIndex': {
                    vscode.commands.executeCommand('vscode-fast-index.buildIndex');
                    break;
                }
                case 'openFile': {
                    const { file, line } = data.value;
                    const document = await vscode.workspace.openTextDocument(file);
                    const editor = await vscode.window.showTextDocument(document);
                    const position = new vscode.Position(line, 0);
                    editor.selection = new vscode.Selection(position, position);
                    editor.revealRange(new vscode.Range(position, position));
                    break;
                }
                case 'getConfig': {
                    const config = vscode.workspace.getConfiguration('fastIndex');
                    this._view?.webview.postMessage({
                        type: 'configData',
                        value: {
                            includeExtensions: config.get<string>('includeExtensions') || '',
                            excludePatterns: config.get<string>('excludePatterns') || '',
                            maxFileSizeKB: config.get<number>('maxFileSizeKB') || 512,
                            maxResults: config.get<number>('maxResults') || 50
                        }
                    });
                    break;
                }
                case 'saveConfig': {
                    try {
                        const config = vscode.workspace.getConfiguration('fastIndex');
                        const target = vscode.ConfigurationTarget.Workspace;
                        await config.update('includeExtensions', data.value.includeExtensions, target);
                        await config.update('excludePatterns', data.value.excludePatterns, target);
                        await config.update('maxFileSizeKB', Number(data.value.maxFileSizeKB), target);
                        await config.update('maxResults', Number(data.value.maxResults), target);
                        
                        vscode.window.showInformationMessage('Fast Index settings saved. Rebuilding index...');
                        vscode.commands.executeCommand('vscode-fast-index.buildIndex');
                        
                        this._view?.webview.postMessage({ type: 'configSaved' });
                    } catch (e) {
                        vscode.window.showErrorMessage('Failed to save settings.');
                    }
                    break;
                }
            }
        });
    }

    private async replaceInFile(file: string, line: number, query: string, replaceText: string, isMatchCase: boolean, isRegex: boolean) {
        const edit = new vscode.WorkspaceEdit();
        await this.applyReplacement(file, line, query, replaceText, edit, isMatchCase, isRegex);
        await vscode.workspace.applyEdit(edit);
    }

    private async replaceAllInFiles(results: any[], query: string, replaceText: string, isMatchCase: boolean, isRegex: boolean) {
        const edit = new vscode.WorkspaceEdit();
        const processed = new Set<string>();
        for (const res of results) {
            const key = `${res.file}:${res.line}`;
            if (!processed.has(key)) {
                processed.add(key);
                await this.applyReplacement(res.file, res.line, query, replaceText, edit, isMatchCase, isRegex);
            }
        }
        await vscode.workspace.applyEdit(edit);
    }

    private async applyReplacement(file: string, line: number, query: string, replaceText: string, edit: vscode.WorkspaceEdit, isMatchCase: boolean, isRegex: boolean) {
        try {
            const uri = vscode.Uri.file(file);
            const document = await vscode.workspace.openTextDocument(uri);
            const content = document.getText();
            
            let flags = 'g';
            if (!isMatchCase) flags += 'i';
            
            let regex: RegExp;
            if (isRegex) {
                regex = new RegExp(query, flags);
            } else {
                const escapedQuery = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                regex = new RegExp(escapedQuery, flags);
            }
            
            let match;
            while ((match = regex.exec(content)) !== null) {
                if (match[0].length === 0) {
                    regex.lastIndex++;
                    continue;
                }
                const matchStartPos = document.positionAt(match.index);
                if (matchStartPos.line === line) {
                    const matchEndPos = document.positionAt(match.index + match[0].length);
                    const range = new vscode.Range(matchStartPos, matchEndPos);
                    
                    let finalReplaceText = replaceText;
                    if (isRegex) {
                        const singleRegex = new RegExp(regex.source, isMatchCase ? '' : 'i');
                        finalReplaceText = match[0].replace(singleRegex, replaceText);
                    }

                    edit.replace(uri, range, finalReplaceText);
                }
            }
        } catch (e) {
            console.error("Replacement error:", e);
        }
    }

    private async getSnippets(files: string[], query: string, isMatchCase: boolean, isRegex: boolean) {
        const snippets: any[] = [];
        
        let flags = 'g';
        if (!isMatchCase) flags += 'i';
        
        let searchRegex: RegExp;
        try {
            if (isRegex) {
                searchRegex = new RegExp(query, flags);
            } else {
                const escapedQuery = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                searchRegex = new RegExp(escapedQuery, flags);
            }
        } catch (e) {
            return []; // Invalid regex pattern
        }
        
        const config = vscode.workspace.getConfiguration('fastIndex');
        const maxResults = config.get<number>('maxResults') || 50;

        const concurrency = 20; // Chunk processing to avoid blocking main thread and opening too many files
        
        for (let i = 0; i < files.length; i += concurrency) {
            const batch = files.slice(i, i + concurrency);
            const promises = batch.map(async (file) => {
                const fileResults: any[] = [];
                try {
                    const content = await fs.promises.readFile(file, 'utf-8');
                    searchRegex.lastIndex = 0;
                    let match;
                    const lines = content.split('\n');
                    
                    while ((match = searchRegex.exec(content)) !== null) {
                        if (match[0].length === 0) {
                            searchRegex.lastIndex++;
                            continue;
                        }
                        
                        // Calculate line number by counting newlines before the match
                        const preMatch = content.substring(0, match.index);
                        let line = 0;
                        for (let k = 0; k < preMatch.length; k++) {
                            if (preMatch[k] === '\n') line++;
                        }
                        
                        fileResults.push({
                            file: file, 
                            fileName: vscode.workspace.asRelativePath(file), 
                            line: line, 
                            text: lines[line].trim()
                        });
                    }
                } catch (e) {}
                return fileResults;
            });

            const results = await Promise.all(promises);
            for (const res of results) {
                snippets.push(...res);
            }
            
            if (snippets.length >= maxResults) break;
        }

        return snippets.slice(0, maxResults);
    }

    private _getHtmlForWebview() {
        const config = vscode.workspace.getConfiguration('fastIndex');
        const debounceDelay = config.get<number>('debounceDelay') || 250;

        return `
            <!DOCTYPE html>
            <html lang="en">
            <head>
                <style>
                    body { font-family: var(--vscode-font-family); padding: 10px; }
                    .search-panel { display: flex; flex-direction: column; gap: 5px; margin-bottom: 10px; }
                    .input-group { display: flex; align-items: center; background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border); }
                    .input-group:focus-within { border-color: var(--vscode-focusBorder); }
                    .input-group input { flex-grow: 1; padding: 6px; background: transparent; color: var(--vscode-input-foreground); border: none; outline: none; box-sizing: border-box; }
                    
                    .toggle-btn { background: transparent; color: var(--vscode-icon-foreground); border: 1px solid transparent; padding: 2px 6px; margin-right: 2px; cursor: pointer; border-radius: 3px; font-size: 1.0em; display: flex; align-items: center; justify-content: center; user-select: none; font-weight: bold; }
                    .toggle-btn:hover { background: var(--vscode-toolbar-hoverBackground); }
                    .toggle-btn.active { background: var(--vscode-inputOption-activeBackground); color: var(--vscode-inputOption-activeForeground); border-color: var(--vscode-inputOption-activeBorder); }

                    .actions { display: flex; gap: 5px; margin-bottom: 10px; }
                    .actions button { flex: 1; }
                    button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 6px 10px; cursor: pointer; display: flex; align-items: center; justify-content: center; font-size: 0.9em; }
                    button:hover { background: var(--vscode-button-hoverBackground); }
                    button:disabled { opacity: 0.5; cursor: not-allowed; }
                    
                    .settings-panel { display: none; flex-direction: column; gap: 8px; margin-bottom: 15px; padding: 10px; background: var(--vscode-editorWidget-background); border: 1px solid var(--vscode-widget-border); border-radius: 4px; }
                    .setting-item { display: flex; flex-direction: column; gap: 3px; }
                    .setting-item label { font-size: 0.85em; font-weight: bold; opacity: 0.9; }
                    .setting-item input { padding: 5px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); }
                    .setting-item input:focus { border-color: var(--vscode-focusBorder); }
                    
                    .result-item { display: flex; flex-direction: column; padding: 6px; margin-bottom: 4px; cursor: pointer; border-left: 2px solid transparent; }
                    .result-item:hover { background: var(--vscode-list-hoverBackground); border-left: 2px solid var(--vscode-activityBarBadge-background); }
                    
                    .result-header { display: flex; justify-content: space-between; align-items: center; }
                    .file-name { font-weight: bold; font-size: 0.9em; color: var(--vscode-textLink-foreground); }
                    
                    .replace-btn { display: none; background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); padding: 2px 8px; font-size: 0.8em; border-radius: 2px; }
                    .replace-btn:hover { background: var(--vscode-button-secondaryHoverBackground); }
                    .result-item:hover .replace-btn { display: block; }

                    .snippet { font-family: monospace; font-size: 0.85em; opacity: 0.8; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-top: 2px; }
                    .highlight { background-color: var(--vscode-editor-findMatchHighlightBackground); color: var(--vscode-editor-foreground); border-radius: 2px; font-weight: bold; }
                </style>
            </head>
            <body>
                <div class="search-panel" id="mainSearchPanel">
                    <div class="input-group">
                        <input type="text" id="searchInput" placeholder="Search..." />
                        <div id="matchCaseBtn" class="toggle-btn" title="Match Case">Aa</div>
                        <div id="regexBtn" class="toggle-btn" title="Use Regular Expression">.*</div>
                    </div>
                    <div class="input-group" id="replaceGroup" style="display: none;">
                        <input type="text" id="replaceInput" placeholder="Replace with..." />
                    </div>
                </div>
                
                <div class="settings-panel" id="settingsPanel">
                    <div class="setting-item">
                        <label>Include Extensions (e.g., ts,js,md)</label>
                        <input type="text" id="confIncludeExt" placeholder="Leave empty for all" />
                    </div>
                    <div class="setting-item">
                        <label>Exclude Patterns (Glob)</label>
                        <input type="text" id="confExcludePat" placeholder="{**/node_modules/**,...}" />
                    </div>
                    <div class="setting-item">
                        <label>Max File Size (KB)</label>
                        <input type="number" id="confMaxFileSize" />
                    </div>
                    <div class="setting-item">
                        <label>Max Search Results</label>
                        <input type="number" id="confMaxResults" />
                    </div>
                    <div style="display: flex; gap: 5px; margin-top: 5px;">
                        <button id="saveConfigBtn" style="flex: 1; background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground);">Save & Reindex</button>
                        <button id="forceReindexBtn" style="flex: 1;" title="Rebuild Index without saving settings">🔄 Force Reindex</button>
                    </div>
                </div>
                
                <div class="actions">
                    <button id="toggleReplaceBtn" title="Toggle Replace Mode">▼ Replace</button>
                    <button id="toggleSettingsBtn" title="Settings">⚙️ Settings</button>
                </div>
                <div class="actions" id="replaceActions" style="display: none;">
                    <button id="replaceAllBtn">Replace All</button>
                </div>
                
                <div id="results"></div>

                <script>
                    const vscode = acquireVsCodeApi();
                    
                    // UI Elements
                    const searchInput = document.getElementById('searchInput');
                    const replaceInput = document.getElementById('replaceInput');
                    const resultsDiv = document.getElementById('results');
                    const toggleReplaceBtn = document.getElementById('toggleReplaceBtn');
                    const toggleSettingsBtn = document.getElementById('toggleSettingsBtn');
                    const replaceGroup = document.getElementById('replaceGroup');
                    const replaceActions = document.getElementById('replaceActions');
                    const replaceAllBtn = document.getElementById('replaceAllBtn');
                    const settingsPanel = document.getElementById('settingsPanel');
                    const saveConfigBtn = document.getElementById('saveConfigBtn');
                    const forceReindexBtn = document.getElementById('forceReindexBtn');
                    const mainSearchPanel = document.getElementById('mainSearchPanel');
                    const matchCaseBtn = document.getElementById('matchCaseBtn');
                    const regexBtn = document.getElementById('regexBtn');

                    // Settings Elements
                    const confIncludeExt = document.getElementById('confIncludeExt');
                    const confExcludePat = document.getElementById('confExcludePat');
                    const confMaxFileSize = document.getElementById('confMaxFileSize');
                    const confMaxResults = document.getElementById('confMaxResults');

                    let isReplaceMode = false;
                    let isSettingsMode = false;
                    let isMatchCase = false;
                    let isRegex = false;
                    let currentResults = [];

                    matchCaseBtn.addEventListener('click', () => {
                        isMatchCase = !isMatchCase;
                        matchCaseBtn.classList.toggle('active', isMatchCase);
                        triggerSearch();
                    });

                    regexBtn.addEventListener('click', () => {
                        isRegex = !isRegex;
                        regexBtn.classList.toggle('active', isRegex);
                        triggerSearch();
                    });

                    toggleReplaceBtn.addEventListener('click', () => {
                        isReplaceMode = !isReplaceMode;
                        replaceGroup.style.display = isReplaceMode ? 'flex' : 'none';
                        replaceActions.style.display = isReplaceMode ? 'flex' : 'none';
                        toggleReplaceBtn.innerText = isReplaceMode ? '▲ Replace' : '▼ Replace';
                    });

                    toggleSettingsBtn.addEventListener('click', () => {
                        isSettingsMode = !isSettingsMode;
                        settingsPanel.style.display = isSettingsMode ? 'flex' : 'none';
                        mainSearchPanel.style.display = isSettingsMode ? 'none' : 'flex';
                        toggleSettingsBtn.style.background = isSettingsMode ? 'var(--vscode-button-hoverBackground)' : '';
                        
                        if (isSettingsMode) {
                            vscode.postMessage({ type: 'getConfig' });
                        }
                    });

                    saveConfigBtn.addEventListener('click', () => {
                        saveConfigBtn.disabled = true;
                        saveConfigBtn.innerText = "Saving...";
                        vscode.postMessage({
                            type: 'saveConfig',
                            value: {
                                includeExtensions: confIncludeExt.value,
                                excludePatterns: confExcludePat.value,
                                maxFileSizeKB: parseInt(confMaxFileSize.value, 10),
                                maxResults: parseInt(confMaxResults.value, 10)
                            }
                        });
                    });

                    forceReindexBtn.addEventListener('click', () => {
                        vscode.postMessage({ type: 'rebuildIndex' });
                        isSettingsMode = false;
                        settingsPanel.style.display = 'none';
                        mainSearchPanel.style.display = 'flex';
                        toggleSettingsBtn.style.background = '';
                    });

                    replaceAllBtn.addEventListener('click', () => {
                        if (currentResults.length === 0) return;
                        const replaceText = replaceInput.value;
                        const query = searchInput.value;
                        if (!query || (!isRegex && query.length < 3)) return;
                        vscode.postMessage({ type: 'replaceAll', value: { results: currentResults, query, replaceText, isMatchCase, isRegex } });
                    });

                    function triggerSearch() {
                        const query = searchInput.value;
                        vscode.postMessage({ type: 'search', value: query, isMatchCase, isRegex }); 
                    }

                    let timeout;
                    searchInput.addEventListener('input', (e) => {
                        clearTimeout(timeout);
                        timeout = setTimeout(triggerSearch, ${debounceDelay});
                    });

                    function escapeHtml(unsafe) {
                        return unsafe.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
                    }

                    function highlightText(text, query, isMatchCase, isRegex) {
                        if (!query) return escapeHtml(text);
                        let flags = 'g';
                        if (!isMatchCase) flags += 'i';
                        let regex;
                        try {
                            if (isRegex) {
                                regex = new RegExp('(' + query + ')', flags);
                            } else {
                                const safeQuery = query.replace(/[.*+?^$}{()|\\[\\]\\\\]/g, '\\\\$&');
                                regex = new RegExp('(' + safeQuery + ')', flags);
                            }
                        } catch (e) {
                            return escapeHtml(text);
                        }

                        const parts = text.split(regex);
                        let result = '';
                        for (let i = 0; i < parts.length; i++) {
                            if (i % 2 !== 0) {
                                result += '<span class="highlight">' + escapeHtml(parts[i]) + '</span>';
                            } else {
                                result += escapeHtml(parts[i]);
                            }
                        }
                        return result;
                    }

                    window.addEventListener('message', event => {
                        const message = event.data;
                        
                        if (message.type === 'configData') {
                            confIncludeExt.value = message.value.includeExtensions;
                            confExcludePat.value = message.value.excludePatterns;
                            confMaxFileSize.value = message.value.maxFileSizeKB;
                            confMaxResults.value = message.value.maxResults;
                        }

                        if (message.type === 'configSaved') {
                            saveConfigBtn.disabled = false;
                            saveConfigBtn.innerText = "Save & Reindex";
                            isSettingsMode = false;
                            settingsPanel.style.display = 'none';
                            mainSearchPanel.style.display = 'flex';
                            toggleSettingsBtn.style.background = '';
                        }

                        if (message.type === 'results') {
                            currentResults = message.value;
                            resultsDiv.innerHTML = '';
                            if (currentResults.length === 0) {
                                resultsDiv.innerHTML = '<p style="opacity: 0.6; font-size: 0.9em;">No results found.</p>';
                                return;
                            }
                            const currentQuery = searchInput.value;
                            currentResults.forEach(item => {
                                const div = document.createElement('div');
                                div.className = 'result-item';
                                
                                const header = document.createElement('div');
                                header.className = 'result-header';
                                header.innerHTML = \`<span class="file-name">\${escapeHtml(item.fileName)} :\${item.line + 1}</span>\`;
                                
                                const replaceBtn = document.createElement('button');
                                replaceBtn.className = 'replace-btn';
                                replaceBtn.innerText = 'Replace';
                                replaceBtn.onclick = (e) => {
                                    e.stopPropagation();
                                    vscode.postMessage({ 
                                        type: 'replaceSingle', 
                                        value: { file: item.file, line: item.line, query: currentQuery, replaceText: replaceInput.value, isMatchCase, isRegex } 
                                    });
                                };
                                header.appendChild(replaceBtn);

                                const snippet = document.createElement('div');
                                snippet.className = 'snippet';
                                snippet.innerHTML = highlightText(item.text, currentQuery, isMatchCase, isRegex);

                                div.appendChild(header);
                                div.appendChild(snippet);
                                
                                div.onclick = () => { vscode.postMessage({ type: 'openFile', value: { file: item.file, line: item.line } }); };
                                resultsDiv.appendChild(div);
                            });
                        }
                    });
                </script>
            </body>
            </html>
        `;
    }
}