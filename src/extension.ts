import * as vscode from 'vscode';
import { ProjectIndexer } from './indexer';
import { SidebarProvider } from './SidebarProvider';

export async function activate(context: vscode.ExtensionContext) {
    const indexer = new ProjectIndexer(context.storageUri);
    const hasCache = await indexer.loadFromDisk();

    if (!hasCache) {
        vscode.window.showInformationMessage(
            'Fast Index: Cache not found. Index the project?', 'Yes'
        ).then(sel => { if (sel === 'Yes') indexer.buildIndex(); });
    }

    const sidebarProvider = new SidebarProvider(context.extensionUri, indexer);
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider("fast-index.sidebar", sidebarProvider)
    );

    let indexCommand = vscode.commands.registerCommand('vscode-fast-index.buildIndex', () => {
        indexer.buildIndex();
    });

    const watcher = vscode.workspace.createFileSystemWatcher('**/*');
    watcher.onDidCreate(uri => indexer.updateFile(uri.fsPath));
    watcher.onDidChange(uri => indexer.updateFile(uri.fsPath));
    watcher.onDidDelete(uri => indexer.deleteFile(uri.fsPath));

    context.subscriptions.push(indexCommand, watcher, { dispose: () => indexer.dispose() });
}

export function deactivate() {}