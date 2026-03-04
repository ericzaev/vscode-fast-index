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
                    if (data.value.length < 3) {
                        this._view?.webview.postMessage({ type: 'results', value: [] });
                        return;
                    }
                    const files = this.indexer.search(data.value);
                    const snippets = await this.getSnippets(files, data.value);
                    this._view?.webview.postMessage({ type: 'results', value: snippets });
                    break;
                }
                case 'replaceSingle': {
                    const { file, line, query, replaceText } = data.value;
                    await this.replaceInFile(file, line, query, replaceText);
                    const files = this.indexer.search(query);
                    const snippets = await this.getSnippets(files, query);
                    this._view?.webview.postMessage({ type: 'results', value: snippets });
                    break;
                }
                case 'replaceAll': {
                    const { results, query, replaceText } = data.value;
                    await this.replaceAllInFiles(results, query, replaceText);
                    const files = this.indexer.search(query);
                    const snippets = await this.getSnippets(files, query);
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
            }
        });
    }

    private async replaceInFile(file: string, line: number, query: string, replaceText: string) {
        const edit = new vscode.WorkspaceEdit();
        await this.applyReplacement(file, line, query, replaceText, edit);
        await vscode.workspace.applyEdit(edit);
    }

    private async replaceAllInFiles(results: any[], query: string, replaceText: string) {
        const edit = new vscode.WorkspaceEdit();
        for (const res of results) {
            await this.applyReplacement(res.file, res.line, query, replaceText, edit);
        }
        await vscode.workspace.applyEdit(edit);
    }

    private async applyReplacement(file: string, line: number, query: string, replaceText: string, edit: vscode.WorkspaceEdit) {
        try {
            const uri = vscode.Uri.file(file);
            const document = await vscode.workspace.openTextDocument(uri);
            const lineText = document.lineAt(line).text;
            
            const escapedQuery = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const regex = new RegExp(escapedQuery, 'gi');
            let match;
            while ((match = regex.exec(lineText)) !== null) {
                const range = new vscode.Range(line, match.index, line, match.index + match[0].length);
                edit.replace(uri, range, replaceText);
            }
        } catch (e) {
            console.error("Replacement error:", e);
        }
    }

    private async getSnippets(files: string[], query: string) {
        const snippets: any[] = [];
        const lowerQuery = query.toLowerCase();
        
        const config = vscode.workspace.getConfiguration('fastIndex');
        const maxResults = config.get<number>('maxResults') || 50;

        const promises = files.map(async (file) => {
            const fileResults: any[] = [];
            try {
                const content = await fs.promises.readFile(file, 'utf-8');
                const lines = content.split('\n');
                for (let i = 0; i < lines.length; i++) {
                    if (lines[i].toLowerCase().includes(lowerQuery)) {
                        fileResults.push({
                            file: file, fileName: vscode.workspace.asRelativePath(file), line: i, text: lines[i].trim()
                        });
                    }
                }
            } catch (e) {}
            return fileResults;
        });

        const results = await Promise.all(promises);
        for (const res of results) {
            snippets.push(...res);
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
                    
                    .actions { display: flex; gap: 5px; margin-bottom: 10px; }
                    .actions button { flex: 1; }
                    button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 6px 10px; cursor: pointer; display: flex; align-items: center; justify-content: center; font-size: 0.9em; }
                    button:hover { background: var(--vscode-button-hoverBackground); }
                    
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
                <div class="search-panel">
                    <div class="input-group">
                        <input type="text" id="searchInput" placeholder="Search..." />
                    </div>
                    <div class="input-group" id="replaceGroup" style="display: none;">
                        <input type="text" id="replaceInput" placeholder="Replace with..." />
                    </div>
                </div>
                
                <div class="actions">
                    <button id="toggleReplaceBtn" title="Toggle Replace Mode">▼ Replace</button>
                    <button id="reindexBtn" title="Rebuild Index">🔄 Index</button>
                </div>
                <div class="actions" id="replaceActions" style="display: none;">
                    <button id="replaceAllBtn">Replace All</button>
                </div>
                
                <div id="results"></div>

                <script>
                    const vscode = acquireVsCodeApi();
                    const searchInput = document.getElementById('searchInput');
                    const replaceInput = document.getElementById('replaceInput');
                    const resultsDiv = document.getElementById('results');
                    const reindexBtn = document.getElementById('reindexBtn');
                    const toggleReplaceBtn = document.getElementById('toggleReplaceBtn');
                    const replaceGroup = document.getElementById('replaceGroup');
                    const replaceActions = document.getElementById('replaceActions');
                    const replaceAllBtn = document.getElementById('replaceAllBtn');

                    let isReplaceMode = false;
                    let currentResults = [];

                    toggleReplaceBtn.addEventListener('click', () => {
                        isReplaceMode = !isReplaceMode;
                        replaceGroup.style.display = isReplaceMode ? 'flex' : 'none';
                        replaceActions.style.display = isReplaceMode ? 'flex' : 'none';
                        toggleReplaceBtn.innerText = isReplaceMode ? '▲ Replace' : '▼ Replace';
                    });

                    reindexBtn.addEventListener('click', () => {
                        vscode.postMessage({ type: 'rebuildIndex' });
                    });

                    replaceAllBtn.addEventListener('click', () => {
                        if (currentResults.length === 0) return;
                        const replaceText = replaceInput.value;
                        const query = searchInput.value.trim();
                        if (query.length < 3) return;
                        vscode.postMessage({ type: 'replaceAll', value: { results: currentResults, query, replaceText } });
                    });

                    let timeout;
                    searchInput.addEventListener('input', (e) => {
                        clearTimeout(timeout);
                        timeout = setTimeout(() => { 
                            vscode.postMessage({ type: 'search', value: e.target.value }); 
                        }, ${debounceDelay});
                    });

                    function escapeHtml(unsafe) {
                        return unsafe.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
                    }

                    function highlightText(text, query) {
                        if (!query) return escapeHtml(text);
                        const safeText = escapeHtml(text);
                        const safeQuery = query.replace(/[.*+?^$}{()|\\[\\]\\\\]/g, '\\\\$&');
                        const regex = new RegExp(\`(\${safeQuery})\`, 'gi');
                        return safeText.replace(regex, '<span class="highlight">$1</span>');
                    }

                    window.addEventListener('message', event => {
                        const message = event.data;
                        if (message.type === 'results') {
                            currentResults = message.value;
                            resultsDiv.innerHTML = '';
                            if (currentResults.length === 0) {
                                resultsDiv.innerHTML = '<p style="opacity: 0.6; font-size: 0.9em;">No results found.</p>';
                                return;
                            }
                            const currentQuery = searchInput.value.trim();
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
                                        value: { file: item.file, line: item.line, query: currentQuery, replaceText: replaceInput.value } 
                                    });
                                };
                                header.appendChild(replaceBtn);

                                const snippet = document.createElement('div');
                                snippet.className = 'snippet';
                                snippet.innerHTML = highlightText(item.text, currentQuery);

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
