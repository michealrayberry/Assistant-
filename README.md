# 🎙️ Recording Assistant

A recording assistant you can **download and use immediately** — no install, no server, no account. The entire app is a single file: `index.html`.

## What it does

- **Record audio** from your microphone, with pause/resume, a live level meter, and a timer
- **Live transcription** while you record (in browsers that support it, e.g. Chrome/Edge) — the transcript is saved with the recording
- **Upload local audio files** — drag & drop or browse (MP3, WAV, M4A, OGG, WEBM, FLAC, AAC, and more)
- **Library** of everything you've recorded or uploaded: play back, rename, add notes, search (searches names, notes, and transcripts)
- **Download** any recording back to disk as an audio file
- **100% private** — everything is stored locally in your browser (IndexedDB). Nothing ever leaves your device.

## How to use it

1. **Download** `index.html` from this repository (or clone the repo).
2. **Double-click** the file — it opens in your browser.
3. Click **Record** and allow microphone access when prompted, or drag an audio file onto the upload area.

That's it. Works on Windows, Mac, Linux, and Android (Chrome). Recommended browsers: **Chrome** or **Edge** (full feature support including live transcription). Firefox and Safari work for recording, uploading, and playback.

## Notes & tips

- Your library persists between sessions as long as you open the file in the same browser. Use the **Download** button on any item to keep a permanent copy on disk.
- Recordings are saved in WebM/Opus format (or your browser's best supported format). Uploaded files keep their original format.
- Live transcription uses your browser's built-in speech recognition (Web Speech API). It requires an internet connection in Chrome and is only available while recording — it can't transcribe uploaded files.
- If you clear your browser's site data, the library is cleared too — download anything you want to keep first.

## Development

There is no build step. Edit `index.html` and refresh the browser.
