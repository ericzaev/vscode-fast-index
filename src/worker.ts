import { parentPort } from 'worker_threads';
import * as fs from 'fs';

function getTrigrams(text: string): string[] {
    const trigrams = new Set<string>();
    const words = text.split(/\W+/).filter(w => w.length >= 3);
    for (const word of words) {
        const lowerWord = word.toLowerCase();
        for (let i = 0; i <= lowerWord.length - 3; i++) {
            trigrams.add(lowerWord.substring(i, i + 3));
        }
    }
    return Array.from(trigrams);
}

parentPort?.on('message', (message: { type: string, filePath?: string, filePaths?: string[] }) => {
    if (message.type === 'processBatch' && message.filePaths) {
        for (const filePath of message.filePaths) {
            try {
                const content = fs.readFileSync(filePath, 'utf-8');
                const trigrams = getTrigrams(content);
                parentPort?.postMessage({ type: 'fileDone', filePath, trigrams });
            } catch (e) {}
        }
        parentPort?.postMessage({ type: 'batchDone' });
    }

    if (message.type === 'processSingle' && message.filePath) {
        try {
            const content = fs.readFileSync(message.filePath, 'utf-8');
            const trigrams = getTrigrams(content);
            parentPort?.postMessage({ type: 'singleDone', filePath: message.filePath, trigrams });
        } catch (e) {}
    }
});