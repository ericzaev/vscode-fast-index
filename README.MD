# Fast Project Indexer ⚡️

**Fast Project Indexer** is a VS Code extension that brings instant, JetBrains-style full-text search and replace functionality to your workspace. 

Instead of searching text "on the fly" for every query, the plugin builds an inverted trigram index in the background once, providing instantaneous search results even in massive codebases.

## Key Features

* **Instant Search:** Results appear as you type (from 3 characters) with zero lag.
* **Trigram Indexing:** Searches not just by whole words, but by word parts (e.g., `calc` will find `calculateTotalPrice`).
* **Find & Replace:** Easily replace text across multiple files or one-by-one with an intuitive UI. Supports multiline code snippets and safe replacements via VS Code's `WorkspaceEdit` (Ctrl+Z to undo).
* **Advanced Matching:** Toggle Case-Sensitive (`Aa`) matching or Regular Expressions (`.*`) right from the search bar.
* **Native Sidebar Integration:** A dedicated activity bar icon ⚡️ ensures the search doesn't clutter your built-in tools. Keeps its state even when you switch tabs.
* **Multithreading:** Heavy file parsing is offloaded to background OS threads. Your VS Code UI won't freeze during indexing.
* **Disk Caching & Live Updates:** The index is saved locally and instantly loads upon restart. Live file watchers keep the index accurate as you code.

## How to Use

1. Open your project in VS Code.
2. Click on the **Lightning Bolt (⚡️)** icon in the Activity Bar on the left.
3. If it's your first time, the plugin will ask to build the index. You can also click the **⚙️ Settings** button and select **Save & Reindex**.
4. Start typing (at least 3 characters) — results with code highlighting will appear instantly. Click on a result to jump directly to the matched line.
5. Click **▼ Replace** to open the replace panel. Hover over a result and click `Replace` for a surgical fix, or use `Replace All`.
6. Use the `Aa` or `.*` toggles in the search input to use case-sensitive or RegEx searches.

## Configuration

You can customize the extension directly via the **⚙️ Settings** UI in the sidebar:
* **Include Extensions:** Limit indexing to specific file types (e.g., `ts,js,md`). Leave empty to index everything.
* **Exclude Patterns:** Glob patterns for files/folders to ignore (e.g., `{**/node_modules/**,**/.git/**}`).
* **Max File Size (KB):** Prevent the indexer from choking on huge minified or binary files (default is `512` KB).
* **Max Search Results:** Limit the number of snippets shown to keep the UI responsive (default is `50`).

## Architecture (Under the Hood)

The plugin uses `Map` and `Set` data structures for lightning-fast memory access, serialized into JSON and stored in the workspace's isolated `storageUri`. A fast set intersection algorithm allows finding exact partial matches across thousands of files in milliseconds. When searching with Regular Expressions or complex special characters, the plugin gracefully falls back to rapid concurrent scanning of cached files.
