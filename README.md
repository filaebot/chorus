# Chorus

ATProto-native community notes with bridging-based consensus.

**Live:** https://chorus.filae.workers.dev

## What is this?

Chorus implements [Community Notes](https://communitynotes.x.com/guide/en/about/introduction)-style collaborative fact-checking for the AT Protocol. The key innovation: notes only get certified when they receive positive ratings from users with *diverse perspectives*.

A note isn't "helpful" because many people say so — it's helpful when people who usually disagree can agree it's helpful.

## How it works

### The Algorithm

Uses matrix factorization (Alternating Least Squares) to learn:

- **Note intercept (i_n)**: How helpful the note is, independent of perspective
- **Note factor (f_n)**: Which "side" the note appeals to
- **User intercept (i_u)**: User's general rating bias
- **User factor (f_u)**: User's perspective/ideology

A note is **certified** when:
- `i_n > 0.35` (genuinely helpful across perspectives)
- `|f_n| < 0.5` (not too aligned with any single perspective)
- `rating_count >= 5` (enough data to be confident)

### Architecture

```
User PDSes (ATProto)          Chorus (Cloudflare)
┌─────────────────────┐       ┌─────────────────────┐
│ site.filae.chorus   │       │ Worker              │
│   .note records     │──────▶│   - Index API       │
│   .rating records   │       │   - Query API       │
└─────────────────────┘       │   - Algorithm (cron)│
                              │                     │
                              │ D1 Database         │
                              │   - Aggregation     │
                              │   - Scores          │
                              └─────────────────────┘
```

Notes and ratings live in user PDSes (portable, user-owned). Chorus aggregates them and runs the bridging algorithm.

## API

### Index endpoints

```bash
# Index a note
curl -X POST https://chorus.filae.workers.dev/api/index/note \
  -H "Content-Type: application/json" \
  -d '{"uri": "at://did:plc:xxx/site.filae.chorus.note/yyy"}'

# Index a rating
curl -X POST https://chorus.filae.workers.dev/api/index/rating \
  -H "Content-Type: application/json" \
  -d '{"uri": "at://did:plc:xxx/site.filae.chorus.rating/yyy"}'
```

### Query endpoints

```bash
# Get notes for any AT-URI
curl "https://chorus.filae.workers.dev/api/notes?subject=at://..."

# Get only certified notes
curl "https://chorus.filae.workers.dev/api/certified?subject=at://..."

# Get a specific note with its ratings
curl "https://chorus.filae.workers.dev/api/note/did:plc:xxx/rkey"

# System stats
curl "https://chorus.filae.workers.dev/api/stats"
```

## Lexicons

### site.filae.chorus.note

A community note on any AT-URI:

```json
{
  "subject": "at://did:plc:xxx/app.bsky.feed.post/yyy",
  "body": "The note content",
  "sources": ["https://example.com/source"],
  "createdAt": "2026-02-23T00:00:00Z"
}
```

### site.filae.chorus.rating

A rating on a note:

```json
{
  "note": "at://did:plc:xxx/site.filae.chorus.note/yyy",
  "helpful": "yes",  // "yes" | "somewhat" | "no"
  "tags": ["clear", "sourced"],
  "createdAt": "2026-02-23T00:00:00Z"
}
```

## Browser Extension

The `extension/` directory contains a Chrome extension that overlays community notes on Bluesky posts:

1. Open `chrome://extensions/`
2. Enable "Developer mode"
3. Click "Load unpacked" and select the `extension/` directory

As you browse Bluesky, posts with community notes will show a badge. Click to expand and see full note details.

## Development

```bash
bun install
bun run dev       # Local development
bun run test      # Run tests
bun run deploy    # Deploy to Cloudflare
```

## References

- [Community Notes Guide](https://communitynotes.x.com/guide/en/about/introduction)
- [Birdwatch Paper](https://github.com/twitter/communitynotes/blob/main/birdwatch_paper_2022_10_27.pdf)
- [AT Protocol](https://atproto.com)
