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

    private async getSnippets(files: string[], query: string) {
        const snippets: any[] = [];
        const lowerQuery = query.toLowerCase();
        
        const config = vscode.workspace.getConfiguration('fastIndex');
        const maxResults = config.get<number>('maxResults') || 50;

        const promises = files.slice(0, maxResults).map(async (file) => {
            try {
                const content = await fs.promises.readFile(file, 'utf-8');
                const lines = content.split('\n');
                for (let i = 0; i < lines.length; i++) {
                    if (lines[i].toLowerCase().includes(lowerQuery)) {
                        return {
                            file: file, fileName: vscode.workspace.asRelativePath(file), line: i, text: lines[i].trim()
                        };
                    }
                }
            } catch (e) {}
            return null;
        });

        const results = await Promise.all(promises);
        for (const res of results) {
            if (res) snippets.push(res);
        }

        return snippets;
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
                    .search-container { display: flex; gap: 5px; margin-bottom: 10px; }
                    input { flex-grow: 1; padding: 6px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); outline: none; box-sizing: border-box; }
                    input:focus { border-color: var(--vscode-focusBorder); }
                    button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 6px 10px; cursor: pointer; display: flex; align-items: center; justify-content: center; }
                    button:hover { background: var(--vscode-button-hoverBackground); }
                    .result-item { padding: 6px; margin-bottom: 6px; cursor: pointer; border-left: 2px solid transparent; }
                    .result-item:hover { background: var(--vscode-list-hoverBackground); border-left: 2px solid var(--vscode-activityBarBadge-background); }
                    .file-name { font-weight: bold; font-size: 0.9em; color: var(--vscode-textLink-foreground); }
                    .snippet { font-family: monospace; font-size: 0.85em; opacity: 0.8; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-top: 2px; }
                    .highlight { background-color: var(--vscode-editor-findMatchHighlightBackground); color: var(--vscode-editor-foreground); border-radius: 2px; font-weight: bold; }
                </style>
            </head>
            <body>
                <div class="search-container">
                    <input type="text" id="searchInput" placeholder="Search from 3 characters..." />
                    <button id="reindexBtn" title="Rebuild project index">🔄</button>
                </div>
                <div id="results"></div>

                <script>
                    const vscode = acquireVsCodeApi();
                    const input = document.getElementById('searchInput');
                    const resultsDiv = document.getElementById('results');
                    const reindexBtn = document.getElementById('reindexBtn');

                    reindexBtn.addEventListener('click', () => {
                        vscode.postMessage({ type: 'rebuildIndex' });
                    });

                    let timeout;
                    input.addEventListener('keyup', (e) => {
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
                            resultsDiv.innerHTML = '';
                            if (message.value.length === 0) {
                                resultsDiv.innerHTML = '<p style="opacity: 0.6; font-size: 0.9em;">No results found.</p>';
                                return;
                            }
                            const currentQuery = input.value.trim();
                            message.value.forEach(item => {
                                const div = document.createElement('div');
                                div.className = 'result-item';
                                const highlightedSnippet = highlightText(item.text, currentQuery);
                                div.innerHTML = \`<div class="file-name">\${escapeHtml(item.fileName)} :\${item.line + 1}</div><div class="snippet">\${highlightedSnippet}</div>\`;
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