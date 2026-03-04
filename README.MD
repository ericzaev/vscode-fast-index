# Fast Project Indexer ⚡️

**Fast Project Indexer** is a VS Code extension that brings instant, JetBrains-style full-text search to your workspace. 

Instead of searching text "on the fly" for every query, the plugin builds an inverted trigram index in the background once, providing instantaneous search results even in massive codebases.

## ✨ Key Features

* 🚀 **Instant Search:** Results appear as you type (from 3 characters) with zero lag.
* 🧠 **Trigram Indexing:** Searches not just by whole words, but by word parts (e.g., `calc` will find `calculateTotalPrice`).
* 🧵 **Multithreading (Worker Threads):** Heavy file parsing is offloaded to background OS threads. Your VS Code UI won't freeze during indexing.
* 🔄 **Live Updates (File Watcher):** The index updates surgically when files are saved, created, or deleted. No full re-indexing required.
* 💾 **Disk Caching:** The index is saved to the local extension storage. Upon restarting VS Code, the plugin instantly loads the ready-to-use database.
* 🎨 **Native UI:** A custom sidebar view with code snippets and smart match highlighting that seamlessly adapts to your editor's theme.

## 🚀 How to Use

1. Open your project in VS Code.
2. Press `Ctrl+Shift+P` (or `Cmd+Shift+P` on Mac) and run the command: **`Fast Index: Build Project Index`**.
3. Wait for the completion notification (the plugin will analyze all files in the background).
4. Open the standard VS Code Search panel (the magnifying glass icon 🔍).
5. Expand the **Fast Index Search** view at the bottom.
6. Start typing (at least 3 characters) — results with code highlighting will appear instantly. Click on a result to jump directly to the matched line.
7. Use the **🔄** button next to the search input to rebuild the index manually if you update the exclusion settings.

## ⚙️ Configuration

You can customize the extension via VS Code Settings (`Ctrl+,` or `Cmd+,`):
* `fastIndex.excludePatterns`: Glob patterns for files/folders to ignore (e.g., `node_modules`, `dist`).
* `fastIndex.maxResults`: Maximum number of search results to render (default is 50).
* `fastIndex.debounceDelay`: Input delay in milliseconds before triggering the search (default is 250).

## 🛠 Architecture (Under the Hood)

The plugin uses `Map` and `Set` data structures for lightning-fast memory access, serialized into JSON and stored in the workspace's isolated `storageUri`. A fast set intersection algorithm allows finding exact partial matches across thousands of files in milliseconds.