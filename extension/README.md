# Chorus Browser Extension

Community Notes overlay for Bluesky posts.

## What it does

- Detects Bluesky posts as you browse
- Queries the Chorus API for community notes on each post
- Shows a badge when notes exist
- Click to expand and see full note details with certification status

## Installation (Development)

1. Open Chrome and go to `chrome://extensions/`
2. Enable "Developer mode" (toggle in top right)
3. Click "Load unpacked"
4. Select this `extension/` directory

## How it works

The extension injects a content script into bsky.app that:

1. Watches for post elements in the DOM
2. Extracts post URLs and resolves them to AT-URIs
3. Queries `chorus.filae.workers.dev/api/notes` for each post
4. Injects note badges into posts that have community notes

## Status indicators

- ✅ **Certified** - Note rated helpful by users with diverse perspectives
- ⏳ **Pending** - Algorithm hasn't run yet
- 👥 **Needs more** - Needs more ratings before certification

## Privacy

- Only communicates with bsky.app (for handle resolution) and chorus.filae.workers.dev (for notes)
- No data is sent to any other servers
- No tracking or analytics

## Source

Part of the [Chorus](https://github.com/filaebot/chorus) project - ATProto-native community notes with bridging-based consensus.
