import * as vscode from 'vscode';
import { Worker } from 'worker_threads';
import * as path from 'path';
import * as fs from 'fs';

export class ProjectIndexer {
    private index: Map<string, Set<string>> = new Map();
    private fileToTrigrams: Map<string, Set<string>> = new Map();
    private isIndexing: boolean = false;
    private worker: Worker;
    private cacheFilePath: string | undefined;

    constructor(storageUri: vscode.Uri | undefined) {
        if (storageUri) {
            if (!fs.existsSync(storageUri.fsPath)) {
                fs.mkdirSync(storageUri.fsPath, { recursive: true });
            }
            this.cacheFilePath = path.join(storageUri.fsPath, 'fast-index-cache.json');
        }

        const workerPath = path.join(__dirname, 'worker.js');
        this.worker = new Worker(workerPath);

        this.worker.on('message', (msg) => {
            if (msg.type === 'fileDone' || msg.type === 'singleDone') {
                this.saveTrigramsToIndex(msg.filePath, msg.trigrams);
            }
        });
    }

    private saveTrigramsToIndex(filePath: string, trigrams: string[]) {
        const trigramSet = new Set(trigrams);
        this.fileToTrigrams.set(filePath, trigramSet);
        for (const trigram of trigrams) {
            if (!this.index.has(trigram)) this.index.set(trigram, new Set());
            this.index.get(trigram)!.add(filePath);
        }
    }

    public async loadFromDisk() {
        if (!this.cacheFilePath) return false;
        try {
            const data = await fs.promises.readFile(this.cacheFilePath, 'utf-8');
            const parsed = JSON.parse(data);
            this.index.clear();
            for (const [trigram, files] of Object.entries(parsed.index)) {
                this.index.set(trigram, new Set(files as string[]));
            }
            this.fileToTrigrams.clear();
            for (const [file, trigrams] of Object.entries(parsed.fileToTrigrams)) {
                this.fileToTrigrams.set(file, new Set(trigrams as string[]));
            }
            return true;
        } catch (e) { return false; }
    }

    private async saveToDisk() {
        if (!this.cacheFilePath) return;
        try {
            const exportIndex: Record<string, string[]> = {};
            for (const [trigram, files] of this.index.entries()) exportIndex[trigram] = Array.from(files);
            const exportFileToTrigrams: Record<string, string[]> = {};
            for (const [file, trigrams] of this.fileToTrigrams.entries()) exportFileToTrigrams[file] = Array.from(trigrams);
            await fs.promises.writeFile(this.cacheFilePath, JSON.stringify({ index: exportIndex, fileToTrigrams: exportFileToTrigrams }), 'utf-8');
        } catch (e) {}
    }

    public async buildIndex() {
        if (this.isIndexing) return;
        this.isIndexing = true;
        this.index.clear();
        this.fileToTrigrams.clear();

        const config = vscode.workspace.getConfiguration('fastIndex');
        const excludePattern = config.get<string>('excludePatterns') || '{**/node_modules/**,**/.git/**}';
        const maxFileSizeKB = config.get<number>('maxFileSizeKB') || 512;
        const includeExtensionsRaw = config.get<string>('includeExtensions') || '';

        let includePattern = '**/*';
        if (includeExtensionsRaw.trim()) {
            const exts = includeExtensionsRaw.split(',').map(e => e.trim()).filter(e => e);
            if (exts.length === 1) {
                includePattern = `**/*.${exts[0]}`;
            } else if (exts.length > 1) {
                includePattern = `**/*.{${exts.join(',')}}`;
            }
        }

        const files = await vscode.workspace.findFiles(includePattern, excludePattern);
        const filePaths = files.map(f => f.fsPath);

        vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: "Indexing project...",
            cancellable: false
        }, (progress) => {
            return new Promise<void>((resolve) => {
                let filesProcessed = 0;
                const onMessage = async (msg: any) => {
                    if (msg.type === 'fileDone') {
                        filesProcessed++;
                        if (filesProcessed % 100 === 0) {
                            const dirName = vscode.workspace.asRelativePath(path.dirname(msg.filePath));
                            progress.report({ 
                                increment: (100 / filePaths.length) * 100,
                                message: `Processed ${filesProcessed} of ${filePaths.length} [${dirName}]`
                            });
                        }
                    } else if (msg.type === 'batchDone') {
                        this.worker.off('message', onMessage);
                        this.isIndexing = false;
                        await this.saveToDisk();
                        vscode.window.showInformationMessage(`Done! Trigram database size: ${this.index.size}`);
                        resolve();
                    }
                };
                this.worker.on('message', onMessage);
                this.worker.postMessage({ type: 'processBatch', filePaths, maxFileSizeKB });
            });
        });
    }

    private removeFileFromIndex(filePath: string) {
        const trigrams = this.fileToTrigrams.get(filePath);
        if (!trigrams) return;
        for (const trigram of trigrams) {
            const filesWithTrigram = this.index.get(trigram);
            if (filesWithTrigram) {
                filesWithTrigram.delete(filePath);
                if (filesWithTrigram.size === 0) this.index.delete(trigram);
            }
        }
        this.fileToTrigrams.delete(filePath);
    }

    public updateFile(filePath: string) {
        if (filePath.includes('node_modules') || filePath.includes('.git')) return;
        this.removeFileFromIndex(filePath);
        const config = vscode.workspace.getConfiguration('fastIndex');
        const maxFileSizeKB = config.get<number>('maxFileSizeKB') || 512;
        this.worker.postMessage({ type: 'processSingle', filePath, maxFileSizeKB });
    }

    public deleteFile(filePath: string) {
        this.removeFileFromIndex(filePath);
    }

    public search(query: string, isRegex: boolean = false): string[] {
        if (isRegex) {
            return Array.from(this.fileToTrigrams.keys());
        }
        if (query.length < 3) return [];
        const lowerQuery = query.toLowerCase();
        
        const queryTrigrams: string[] = [];
        const words = lowerQuery.split(/\W+/).filter(w => w.length >= 3);
        for (const word of words) {
            for (let i = 0; i <= word.length - 3; i++) {
                queryTrigrams.push(word.substring(i, i + 3));
            }
        }

        // If the query contains special characters and doesn't yield any valid >=3 char words
        // (e.g. "$$$" or "()=>"), fallback to scanning all cached files.
        if (queryTrigrams.length === 0) {
            return Array.from(this.fileToTrigrams.keys());
        }

        let resultFiles = new Set(this.index.get(queryTrigrams[0]) || []);
        for (let i = 1; i < queryTrigrams.length; i++) {
            const currentTrigramFiles = this.index.get(queryTrigrams[i]) || new Set();
            resultFiles = new Set([...resultFiles].filter(file => currentTrigramFiles.has(file)));
            if (resultFiles.size === 0) break;
        }
        return Array.from(resultFiles);
    }

    public dispose() {
        this.worker.terminate();
    }
}