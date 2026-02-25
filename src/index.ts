/**
 * Chorus - ATProto Community Notes with Bridging-Based Consensus
 *
 * Architecture:
 * - Notes and ratings stored in user PDSes (ATProto source of truth)
 * - D1 for aggregation, algorithm computation, and status tracking
 * - Scheduled algorithm runs every 5 minutes
 * - No OAuth needed for reads; indexing verifies ownership via PDS
 */

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import {
  runBridgingAlgorithm,
  certifyNotes,
  computeAverageRatings,
  type Rating,
} from './bridging';

interface Env {
  DB: D1Database;
}

const app = new Hono<{ Bindings: Env }>();

// CORS for all routes
app.use('*', cors());

// API info (JSON)
app.get('/api', (c) => {
  return c.json({
    service: 'chorus',
    description: 'ATProto Community Notes with Bridging-Based Consensus',
    endpoints: {
      'POST /api/index/note': 'Index a note from ATProto',
      'POST /api/index/rating': 'Index a rating from ATProto',
      'GET /api/notes': 'Get notes for a subject URI',
      'GET /api/certified': 'Get certified notes for a subject URI',
      'GET /api/note/:did/:rkey': 'Get a specific note',
      'GET /api/stats': 'Get system statistics',
      'POST /api/admin/run': 'Manually run the bridging algorithm',
    },
  });
});

// OAuth client metadata (required for ATProto OAuth)
app.get('/oauth/client-metadata.json', (c) => {
  const origin = new URL(c.req.url).origin;
  return c.json({
    client_id: `${origin}/oauth/client-metadata.json`,
    client_name: 'Chorus',
    client_uri: origin,
    redirect_uris: [`${origin}/oauth/callback`],
    scope: 'atproto repo:site.filae.chorus.note repo:site.filae.chorus.rating',
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
    application_type: 'web',
    dpop_bound_access_tokens: true,
  });
});

// OAuth callback page — preserve query params (code, state, iss) for BrowserOAuthClient.init()
app.get('/oauth/callback', (c) => {
  return c.html(`<!DOCTYPE html>
<html><head><title>Chorus - Redirecting...</title></head>
<body><p>Completing sign-in...</p>
<script>window.location.href = '/' + window.location.search + window.location.hash;</script>
</body></html>`);
});

// Main UI
app.get('/', (c) => {
  const origin = new URL(c.req.url).origin;
  return c.html(renderUI(origin));
});

// =============================================================================
// Indexing Endpoints
// =============================================================================

/**
 * Index a note from ATProto.
 * Verifies the record exists on the author's PDS before indexing.
 */
app.post('/api/index/note', async (c) => {
  const body = await c.req.json<{
    uri: string;  // at://did/site.filae.chorus.note/tid
  }>();

  if (!body.uri) {
    return c.json({ error: 'uri is required' }, 400);
  }

  // Parse AT-URI
  const uriMatch = body.uri.match(/^at:\/\/([^/]+)\/([^/]+)\/([^/]+)$/);
  if (!uriMatch) {
    return c.json({ error: 'Invalid AT-URI format' }, 400);
  }

  const [, did, collection, rkey] = uriMatch;

  if (collection !== 'site.filae.chorus.note') {
    return c.json({ error: 'Invalid collection - must be site.filae.chorus.note' }, 400);
  }

  // Verify record exists on PDS
  const record = await fetchRecord(did, collection, rkey);
  if (!record) {
    return c.json({ error: 'Record not found on PDS' }, 404);
  }

  const now = new Date().toISOString();

  // Index the note
  await c.env.DB.prepare(`
    INSERT INTO notes (uri, did, subject_uri, body, sources, created_at, indexed_at, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')
    ON CONFLICT(uri) DO UPDATE SET
      body = excluded.body,
      sources = excluded.sources,
      indexed_at = excluded.indexed_at
  `).bind(
    body.uri,
    did,
    record.subject,
    record.body,
    record.sources ? JSON.stringify(record.sources) : null,
    record.createdAt,
    now,
  ).run();

  return c.json({ success: true, uri: body.uri, status: 'indexed' });
});

/**
 * Index a rating from ATProto.
 * Verifies the record exists on the rater's PDS before indexing.
 */
app.post('/api/index/rating', async (c) => {
  const body = await c.req.json<{
    uri: string;  // at://did/site.filae.chorus.rating/tid
  }>();

  if (!body.uri) {
    return c.json({ error: 'uri is required' }, 400);
  }

  // Parse AT-URI
  const uriMatch = body.uri.match(/^at:\/\/([^/]+)\/([^/]+)\/([^/]+)$/);
  if (!uriMatch) {
    return c.json({ error: 'Invalid AT-URI format' }, 400);
  }

  const [, did, collection, rkey] = uriMatch;

  if (collection !== 'site.filae.chorus.rating') {
    return c.json({ error: 'Invalid collection - must be site.filae.chorus.rating' }, 400);
  }

  // Verify record exists on PDS
  const record = await fetchRecord(did, collection, rkey);
  if (!record) {
    return c.json({ error: 'Record not found on PDS' }, 404);
  }

  // Map helpful enum to score
  const helpfulMap: Record<string, number> = {
    'yes': 1.0,
    'somewhat': 0.5,
    'no': 0.0,
  };
  const helpful = helpfulMap[record.helpful] ?? 0.5;

  const now = new Date().toISOString();

  // Index the rating
  await c.env.DB.prepare(`
    INSERT INTO ratings (uri, did, note_uri, helpful, tags, created_at, indexed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(did, note_uri) DO UPDATE SET
      uri = excluded.uri,
      helpful = excluded.helpful,
      tags = excluded.tags,
      indexed_at = excluded.indexed_at
  `).bind(
    body.uri,
    did,
    record.note,
    helpful,
    record.tags ? JSON.stringify(record.tags) : null,
    record.createdAt,
    now,
  ).run();

  // Update note's rating count
  await c.env.DB.prepare(`
    UPDATE notes SET
      rating_count = (SELECT COUNT(*) FROM ratings WHERE note_uri = ?),
      avg_rating = (SELECT AVG(helpful) FROM ratings WHERE note_uri = ?)
    WHERE uri = ?
  `).bind(record.note, record.note, record.note).run();

  return c.json({ success: true, uri: body.uri, noteUri: record.note, status: 'indexed' });
});

// =============================================================================
// Query Endpoints
// =============================================================================

/**
 * Get all notes for a subject URI.
 */
app.get('/api/notes', async (c) => {
  const subject = c.req.query('subject');
  if (!subject) {
    return c.json({ error: 'subject query param is required' }, 400);
  }

  const notes = await c.env.DB.prepare(`
    SELECT uri, did, subject_uri, body, sources, created_at,
           rating_count, intercept, factor, status, avg_rating
    FROM notes
    WHERE subject_uri = ?
    ORDER BY intercept DESC, rating_count DESC
  `).bind(subject).all();

  return c.json({
    subject,
    count: notes.results?.length || 0,
    notes: notes.results?.map(formatNote) || [],
  });
});

/**
 * Get certified notes only for a subject URI.
 */
app.get('/api/certified', async (c) => {
  const subject = c.req.query('subject');
  if (!subject) {
    return c.json({ error: 'subject query param is required' }, 400);
  }

  const notes = await c.env.DB.prepare(`
    SELECT uri, did, subject_uri, body, sources, created_at,
           rating_count, intercept, factor, status, avg_rating
    FROM notes
    WHERE subject_uri = ? AND status = 'certified'
    ORDER BY intercept DESC
  `).bind(subject).all();

  return c.json({
    subject,
    count: notes.results?.length || 0,
    notes: notes.results?.map(formatNote) || [],
  });
});

/**
 * Get a specific note by DID and rkey.
 */
app.get('/api/note/:did/:rkey', async (c) => {
  const did = c.req.param('did');
  const rkey = c.req.param('rkey');
  const uri = `at://${did}/site.filae.chorus.note/${rkey}`;

  const note = await c.env.DB.prepare(`
    SELECT uri, did, subject_uri, body, sources, created_at,
           rating_count, intercept, factor, status, avg_rating
    FROM notes
    WHERE uri = ?
  `).bind(uri).first();

  if (!note) {
    return c.json({ error: 'Note not found' }, 404);
  }

  // Get ratings for this note
  const ratings = await c.env.DB.prepare(`
    SELECT did, helpful, tags, created_at FROM ratings WHERE note_uri = ?
  `).bind(uri).all();

  return c.json({
    note: formatNote(note),
    ratings: ratings.results?.map((r) => ({
      rater: r.did,
      helpful: r.helpful === 1.0 ? 'yes' : r.helpful === 0.5 ? 'somewhat' : 'no',
      tags: r.tags ? JSON.parse(r.tags as string) : [],
      createdAt: r.created_at,
    })) || [],
  });
});

/**
 * Get system statistics.
 */
app.get('/api/stats', async (c) => {
  const stats = await c.env.DB.batch([
    c.env.DB.prepare('SELECT COUNT(*) as count FROM notes'),
    c.env.DB.prepare('SELECT COUNT(*) as count FROM notes WHERE status = ?').bind('certified'),
    c.env.DB.prepare('SELECT COUNT(*) as count FROM notes WHERE status = ?').bind('pending'),
    c.env.DB.prepare('SELECT COUNT(*) as count FROM notes WHERE status = ?').bind('needs_more'),
    c.env.DB.prepare('SELECT COUNT(*) as count FROM ratings'),
    c.env.DB.prepare('SELECT COUNT(DISTINCT did) as count FROM ratings'),
    c.env.DB.prepare('SELECT * FROM algorithm_runs ORDER BY id DESC LIMIT 1'),
  ]);

  return c.json({
    notes: {
      total: (stats[0].results?.[0] as any)?.count || 0,
      certified: (stats[1].results?.[0] as any)?.count || 0,
      pending: (stats[2].results?.[0] as any)?.count || 0,
      needsMore: (stats[3].results?.[0] as any)?.count || 0,
    },
    ratings: {
      total: (stats[4].results?.[0] as any)?.count || 0,
      uniqueRaters: (stats[5].results?.[0] as any)?.count || 0,
    },
    lastRun: stats[6].results?.[0] || null,
  });
});

// =============================================================================
// Admin Endpoints
// =============================================================================

/**
 * Manually trigger the bridging algorithm.
 * In production, this should be protected.
 */
app.post('/api/admin/run', async (c) => {
  const result = await runAlgorithm(c.env.DB);
  return c.json(result);
});

// =============================================================================
// Scheduled Handler
// =============================================================================

async function scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
  ctx.waitUntil(runAlgorithm(env.DB));
}

// =============================================================================
// Algorithm Runner
// =============================================================================

async function runAlgorithm(db: D1Database) {
  const startedAt = new Date().toISOString();

  // Record algorithm run start
  const run = await db.prepare(`
    INSERT INTO algorithm_runs (started_at, status) VALUES (?, 'running')
  `).bind(startedAt).run();
  const runId = run.meta.last_row_id;

  try {
    // Load all ratings
    const ratingsResult = await db.prepare(`
      SELECT did as userId, note_uri as noteId, helpful as score FROM ratings
    `).all();

    const ratings: Rating[] = (ratingsResult.results || []) as any[];

    if (ratings.length === 0) {
      // No ratings yet
      await db.prepare(`
        UPDATE algorithm_runs
        SET completed_at = ?, status = 'completed', notes_processed = 0, ratings_processed = 0
        WHERE id = ?
      `).bind(new Date().toISOString(), runId).run();

      return { success: true, message: 'No ratings to process', runId };
    }

    // Run bridging algorithm
    const params = runBridgingAlgorithm(ratings, 20);

    // Get rating counts per note
    const ratingCounts = new Map<string, number>();
    for (const r of ratings) {
      ratingCounts.set(r.noteId, (ratingCounts.get(r.noteId) || 0) + 1);
    }

    // Get average ratings
    const avgRatings = computeAverageRatings(ratings);

    // Certify notes
    const noteStatuses = certifyNotes(params, ratingCounts);

    // Update notes with computed values
    let certified = 0;
    let rejected = 0;

    for (const ns of noteStatuses) {
      const avg = avgRatings.get(ns.noteId) || 0;

      await db.prepare(`
        UPDATE notes SET
          intercept = ?,
          factor = ?,
          rating_count = ?,
          avg_rating = ?,
          status = ?,
          status_updated_at = ?
        WHERE uri = ?
      `).bind(
        ns.intercept,
        ns.factor,
        ns.ratingCount,
        avg,
        ns.status,
        new Date().toISOString(),
        ns.noteId,
      ).run();

      if (ns.status === 'certified') certified++;
      if (ns.status === 'rejected') rejected++;
    }

    // Update rater profiles
    for (const [did, factor] of params.userFactors) {
      const intercept = params.userIntercepts.get(did) || 0;
      const ratingCount = ratings.filter((r) => r.userId === did).length;

      await db.prepare(`
        INSERT INTO raters (did, factor, intercept, rating_count, last_updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(did) DO UPDATE SET
          factor = excluded.factor,
          intercept = excluded.intercept,
          rating_count = excluded.rating_count,
          last_updated_at = excluded.last_updated_at
      `).bind(did, factor, intercept, ratingCount, new Date().toISOString()).run();
    }

    // Complete algorithm run
    await db.prepare(`
      UPDATE algorithm_runs SET
        completed_at = ?,
        status = 'completed',
        notes_processed = ?,
        ratings_processed = ?,
        notes_certified = ?,
        notes_rejected = ?,
        iterations = 20
      WHERE id = ?
    `).bind(
      new Date().toISOString(),
      noteStatuses.length,
      ratings.length,
      certified,
      rejected,
      runId,
    ).run();

    return {
      success: true,
      runId,
      notesProcessed: noteStatuses.length,
      ratingsProcessed: ratings.length,
      certified,
      rejected,
    };
  } catch (error) {
    // Record failure
    await db.prepare(`
      UPDATE algorithm_runs SET completed_at = ?, status = 'failed' WHERE id = ?
    `).bind(new Date().toISOString(), runId).run();

    throw error;
  }
}

// =============================================================================
// Helpers
// =============================================================================

/**
 * Fetch a record from a PDS.
 */
async function fetchRecord(did: string, collection: string, rkey: string): Promise<any | null> {
  try {
    // Resolve DID to PDS URL
    let pdsUrl = 'https://bsky.social';  // Default

    if (did.startsWith('did:plc:')) {
      const plcRes = await fetch(`https://plc.directory/${did}`);
      if (plcRes.ok) {
        const doc = await plcRes.json() as any;
        const endpoint = doc.service?.find((s: any) => s.type === 'AtprotoPersonalDataServer');
        if (endpoint?.serviceEndpoint) {
          pdsUrl = endpoint.serviceEndpoint;
        }
      }
    }

    // Fetch record
    const url = `${pdsUrl}/xrpc/com.atproto.repo.getRecord?repo=${did}&collection=${collection}&rkey=${rkey}`;
    const res = await fetch(url);

    if (!res.ok) return null;

    const data = await res.json() as any;
    return data.value;
  } catch {
    return null;
  }
}

/**
 * Format a note for JSON response.
 */
function formatNote(row: any) {
  return {
    uri: row.uri,
    author: row.did,
    subject: row.subject_uri,
    body: row.body,
    sources: row.sources ? JSON.parse(row.sources) : [],
    createdAt: row.created_at,
    stats: {
      ratingCount: row.rating_count,
      avgRating: row.avg_rating,
      intercept: row.intercept,
      factor: row.factor,
      status: row.status,
    },
  };
}

// =============================================================================
// UI Template
// =============================================================================

function renderUI(origin: string): string {
  const clientId = `${origin}/oauth/client-metadata.json`;
  const redirectUri = `${origin}/oauth/callback`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>CHORUS — Community Notes</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Space+Mono:wght@400;700&family=Instrument+Serif:ital@0;1&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg: #0a0a0a;
      --surface: #111;
      --surface-elevated: #1a1a1a;
      --border: #333;
      --border-heavy: #555;
      --text: #f0f0f0;
      --text-muted: #aaa;
      --accent: #ff3e00;
      --accent-glow: rgba(255, 62, 0, 0.3);
      --certified: #00ff88;
      --certified-glow: rgba(0, 255, 136, 0.2);
      --pending: #ffcc00;
      --needs-more: #00ccff;
      --rejected: #ff0055;
      --mono: 'Space Mono', monospace;
      --serif: 'Instrument Serif', Georgia, serif;
    }

    * { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      font-family: var(--mono);
      background: var(--bg);
      color: var(--text);
      min-height: 100vh;
      font-size: 14px;
      line-height: 1.6;
      /* Noise texture overlay - subtle */
      position: relative;
    }
    body::before {
      content: '';
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background-image: url("data:image/svg+xml,%3Csvg viewBox='0 0 400 400' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noiseFilter'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23noiseFilter)'/%3E%3C/svg%3E");
      background-size: 200px 200px;
      opacity: 0.03;
      pointer-events: none;
      z-index: 0;
    }

    ::selection {
      background: var(--accent);
      color: var(--bg);
    }

    .container {
      max-width: 900px;
      margin: 0 auto;
      padding: 40px 20px;
      position: relative;
      z-index: 1;
    }

    /* HEADER - Brutalist typography */
    header {
      margin-bottom: 60px;
      position: relative;
    }

    .logo {
      font-family: var(--serif);
      font-size: clamp(4rem, 15vw, 8rem);
      font-weight: 400;
      letter-spacing: -0.03em;
      line-height: 0.85;
      color: var(--text);
      position: relative;
      display: inline-block;
    }

    .logo::before {
      content: 'CHORUS';
      position: absolute;
      left: 3px;
      top: 3px;
      color: var(--accent);
      z-index: -1;
      opacity: 0.7;
    }

    .tagline {
      font-family: var(--mono);
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.2em;
      color: var(--text-muted);
      margin-top: 20px;
      padding-left: 4px;
      border-left: 2px solid var(--accent);
    }

    /* SECTIONS - Asymmetric boxes */
    .section {
      background: var(--surface);
      border: 1px solid var(--border);
      margin-bottom: 24px;
      position: relative;
    }

    .section::before {
      content: '';
      position: absolute;
      top: -1px;
      left: 20px;
      right: 20px;
      height: 1px;
      background: linear-gradient(90deg, transparent, var(--accent), transparent);
    }

    .section-header {
      padding: 12px 20px;
      border-bottom: 1px solid var(--border);
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 0.15em;
      color: var(--text-muted);
      display: flex;
      justify-content: space-between;
      align-items: center;
    }

    .section-body {
      padding: 20px;
    }

    /* AUTH */
    .auth-logged-in {
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .handle {
      color: var(--accent);
      font-weight: 700;
    }

    /* INPUTS - Raw, brutalist */
    input[type="text"], textarea {
      width: 100%;
      padding: 14px 16px;
      border: 1px solid var(--border);
      background: var(--bg);
      color: var(--text);
      font-family: var(--mono);
      font-size: 16px; /* Prevents iOS zoom on focus */
      transition: all 0.15s ease;
    }

    input[type="text"]:focus, textarea:focus {
      outline: none;
      border-color: var(--accent);
      box-shadow: 0 0 0 1px var(--accent), 0 0 20px var(--accent-glow);
    }

    input::placeholder, textarea::placeholder {
      color: var(--text-muted);
      opacity: 0.6;
    }

    textarea {
      min-height: 100px;
      resize: vertical;
      line-height: 1.5;
    }

    /* BUTTONS - Bold, stark */
    button {
      font-family: var(--mono);
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.1em;
      padding: 12px 24px;
      border: 1px solid var(--border);
      cursor: pointer;
      transition: all 0.15s ease;
      position: relative;
      overflow: hidden;
    }

    .btn-primary {
      background: var(--accent);
      color: var(--bg);
      border-color: var(--accent);
      font-weight: 700;
    }

    .btn-primary:hover {
      background: var(--text);
      border-color: var(--text);
      box-shadow: 0 0 30px var(--accent-glow);
    }

    .btn-secondary {
      background: transparent;
      color: var(--text);
    }

    .btn-secondary:hover {
      background: var(--surface-elevated);
      border-color: var(--text-muted);
    }

    button:disabled {
      opacity: 0.3;
      cursor: not-allowed;
    }

    /* SEARCH ROW */
    .search-row {
      display: flex;
      gap: 0;
    }

    .search-row input {
      flex: 1;
      border-right: none;
    }

    .search-row button {
      white-space: nowrap;
      min-width: 100px; /* Prevents button resize during loading state */
    }

    /* STATS - Horizontal ticker style */
    .stats-row {
      display: flex;
      gap: 0;
      border: 1px solid var(--border);
      margin-bottom: 24px;
      overflow: hidden;
    }

    .stat-item {
      flex: 1;
      padding: 16px 20px;
      border-right: 1px solid var(--border);
      text-align: center;
    }

    .stat-item:last-child {
      border-right: none;
    }

    .stat-value {
      font-size: 28px;
      font-weight: 700;
      color: var(--text);
      font-family: var(--serif);
      font-style: italic;
    }

    .stat-label {
      font-size: 9px;
      text-transform: uppercase;
      letter-spacing: 0.15em;
      color: var(--text-muted);
      margin-top: 4px;
    }

    /* NOTES */
    .notes-header {
      display: flex;
      justify-content: space-between;
      align-items: baseline;
      margin-bottom: 20px;
    }

    .notes-title {
      font-family: var(--serif);
      font-size: 24px;
      font-style: italic;
    }

    .note-count {
      font-size: 11px;
      color: var(--text-muted);
      text-transform: uppercase;
      letter-spacing: 0.1em;
    }

    .note-item {
      background: var(--bg);
      border: 1px solid var(--border);
      margin-bottom: 16px;
      position: relative;
    }

    .note-item::after {
      content: '';
      position: absolute;
      bottom: 0;
      left: 0;
      width: 100%;
      height: 2px;
      background: linear-gradient(90deg, var(--border-heavy) 0%, transparent 100%);
    }

    .note-body {
      padding: 20px;
      font-size: 15px;
      line-height: 1.7;
      font-family: var(--serif);
    }

    .note-meta {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 12px 20px;
      border-top: 1px solid var(--border);
      font-size: 11px;
      color: var(--text-muted);
    }

    .note-author {
      font-family: var(--mono);
      letter-spacing: 0.05em;
    }

    /* STATUS BADGES - Stark, industrial */
    .note-status {
      padding: 4px 10px;
      font-size: 9px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.1em;
      font-family: var(--mono);
    }

    .status-certified {
      background: var(--certified);
      color: var(--bg);
      box-shadow: 0 0 20px var(--certified-glow);
    }

    .status-pending {
      background: var(--pending);
      color: var(--bg);
    }

    .status-needs_more {
      background: var(--needs-more);
      color: var(--bg);
    }

    .status-rejected {
      background: var(--rejected);
      color: var(--text);
    }

    .note-sources {
      padding: 12px 20px;
      border-top: 1px solid var(--border);
      font-size: 12px;
    }

    .note-sources a {
      color: var(--accent);
      text-decoration: none;
      border-bottom: 1px solid transparent;
      transition: border-color 0.15s;
    }

    .note-sources a:hover {
      border-bottom-color: var(--accent);
    }

    /* RATING BUTTONS */
    .rating-buttons {
      display: flex;
      gap: 0;
      padding: 0 20px 20px;
    }

    .rating-btn {
      flex: 1;
      padding: 10px 12px;
      font-size: 10px;
      border-right-width: 0;
    }

    .rating-btn:last-child {
      border-right-width: 1px;
    }

    .rating-btn.active {
      background: var(--accent);
      color: var(--bg);
      border-color: var(--accent);
    }

    /* FORM */
    .form-group {
      margin-bottom: 20px;
    }

    .form-label {
      display: block;
      margin-bottom: 8px;
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 0.15em;
      color: var(--text-muted);
    }

    /* INFO BOX */
    .info-box {
      background: var(--surface-elevated);
      border-left: 3px solid var(--accent);
      padding: 16px 20px;
      margin-bottom: 24px;
      font-size: 13px;
      line-height: 1.6;
    }

    .info-box strong {
      color: var(--accent);
      font-weight: 700;
    }

    .info-box em {
      font-family: var(--serif);
      font-style: italic;
    }

    /* EMPTY STATE */
    .empty-state {
      text-align: center;
      padding: 60px 20px;
      color: var(--text-muted);
      font-family: var(--serif);
      font-style: italic;
      font-size: 16px;
    }

    /* MESSAGES */
    .message {
      padding: 14px 20px;
      margin-bottom: 20px;
      font-size: 13px;
      border-left: 3px solid;
    }

    .message-error {
      background: rgba(255, 0, 85, 0.1);
      border-color: var(--rejected);
      color: #ff6b8a;
    }

    .message-success {
      background: rgba(0, 255, 136, 0.1);
      border-color: var(--certified);
      color: var(--certified);
    }

    /* LOGIN */
    .login-form {
      display: flex;
      gap: 0;
    }

    .login-form .handle-input-wrapper {
      flex: 1;
      position: relative;
    }

    .login-form .handle-input-wrapper input {
      width: 100%;
      border-right: none;
    }

    .typeahead-dropdown {
      display: none;
      position: absolute;
      top: 100%;
      left: 0;
      right: 0;
      background: var(--surface);
      border: 1px solid var(--border);
      border-top: none;
      max-height: 320px;
      overflow-y: auto;
      z-index: 100;
    }

    .typeahead-dropdown.visible {
      display: block;
    }

    .typeahead-item {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 8px 12px;
      cursor: pointer;
      transition: background 0.1s;
    }

    .typeahead-item:hover,
    .typeahead-item.selected {
      background: rgba(255, 62, 0, 0.1);
    }

    .typeahead-avatar {
      width: 32px;
      height: 32px;
      border-radius: 50%;
      object-fit: cover;
      background: var(--border);
      flex-shrink: 0;
    }

    .typeahead-info {
      min-width: 0;
      flex: 1;
    }

    .typeahead-name {
      font-size: 13px;
      color: var(--text);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .typeahead-handle {
      font-size: 11px;
      color: var(--text-muted);
      font-family: var(--mono);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .typeahead-loading,
    .typeahead-empty {
      padding: 12px;
      font-size: 12px;
      color: var(--text-muted);
      text-align: center;
      font-family: var(--mono);
    }

    .hidden { display: none !important; }

    /* DECORATIVE ELEMENTS */
    .corner-mark {
      position: fixed;
      font-size: 10px;
      color: var(--text-muted);
      opacity: 0.4;
      font-family: var(--mono);
      letter-spacing: 0.1em;
    }

    .corner-mark.top-right {
      top: 20px;
      right: 20px;
    }

    .corner-mark.bottom-left {
      bottom: 20px;
      left: 20px;
    }

    /* RESPONSIVE */
    @media (max-width: 600px) {
      .logo { font-size: 3.5rem; }
      .stats-row { flex-direction: column; }
      .stat-item { border-right: none; border-bottom: 1px solid var(--border); }
      .stat-item:last-child { border-bottom: none; }
      .search-row { flex-direction: column; }
      .search-row input { border-right: 1px solid var(--border); border-bottom: none; }
      .login-form { flex-direction: column; }
      .login-form .handle-input-wrapper input { border-right: 1px solid var(--border); border-bottom: none; }
    }
  </style>
</head>
<body>
  <div class="corner-mark top-right">ATProto × Bridging</div>
  <div class="corner-mark bottom-left">v0.1</div>

  <div class="container">
    <header>
      <div class="logo">CHORUS</div>
      <p class="tagline">Community notes with bridging-based consensus</p>
    </header>

    <div id="message" class="hidden"></div>

    <!-- Stats -->
    <div class="stats-row">
      <div class="stat-item">
        <div class="stat-value" id="stat-notes">—</div>
        <div class="stat-label">Notes</div>
      </div>
      <div class="stat-item">
        <div class="stat-value" id="stat-certified">—</div>
        <div class="stat-label">Certified</div>
      </div>
      <div class="stat-item">
        <div class="stat-value" id="stat-raters">—</div>
        <div class="stat-label">Raters</div>
      </div>
    </div>

    <!-- Auth Section -->
    <div class="section">
      <div class="section-header">
        <span>Identity</span>
      </div>
      <div class="section-body">
        <div id="auth-loading">Initializing...</div>
        <div id="auth-logged-out" class="hidden">
          <div class="login-form">
            <div class="handle-input-wrapper">
              <input type="text" id="handle-input" placeholder="yourname.bsky.social" autocomplete="off" autocapitalize="off" spellcheck="false" />
              <div class="typeahead-dropdown" id="typeahead-dropdown"></div>
            </div>
            <button id="login-btn" class="btn-primary">Connect</button>
          </div>
        </div>
        <div id="auth-logged-in" class="auth-logged-in hidden">
          <span>Connected as <span class="handle" id="user-handle"></span></span>
          <button id="logout-btn" class="btn-secondary">Disconnect</button>
        </div>
      </div>
    </div>

    <!-- Search Section -->
    <div class="section">
      <div class="section-header">
        <span>Lookup</span>
      </div>
      <div class="section-body">
        <div class="search-row">
          <input type="text" id="subject-input" placeholder="Paste Bluesky post URL" />
          <button id="search-btn" class="btn-primary">Search</button>
        </div>
      </div>
    </div>

    <!-- Notes Section (shown after search) -->
    <div id="notes-section" class="section hidden">
      <div class="section-header">
        <span>Notes</span>
        <span class="note-count" id="note-count"></span>
      </div>
      <div class="section-body">
        <div id="notes-list"></div>
        <div id="empty-notes" class="empty-state hidden">
          No notes yet. Be the first to add context.
        </div>
      </div>
    </div>

    <!-- Create Note Section (shown after search, if logged in) -->
    <div id="create-note-section" class="section hidden">
      <div class="section-header">
        <span>Add Note</span>
      </div>
      <div class="section-body">
        <div class="info-box">
          <strong>How it works:</strong> Notes get certified when people with
          <em>diverse perspectives</em> agree they are helpful.
          Partisan notes that only appeal to one viewpoint do not make the cut.
        </div>
        <div class="form-group">
          <label class="form-label">Your note</label>
          <textarea id="note-body" placeholder="Add helpful context, fact-checks, or clarifications..."></textarea>
        </div>
        <div class="form-group">
          <label class="form-label">Sources (optional)</label>
          <textarea id="note-sources" placeholder="https://example.com/source" style="min-height: 60px;"></textarea>
        </div>
        <button id="submit-note-btn" class="btn-primary">Submit Note</button>
      </div>
    </div>
  </div>

  <!-- Fallback: if module import takes too long, show login form anyway -->
  <!-- Longer timeout on callback (token exchange takes time), shorter for normal load -->
  <script>
    (function() {
      var isCallback = window.location.search.indexOf('code=') !== -1 || window.location.search.indexOf('state=') !== -1;
      var timeout = isCallback ? 20000 : 8000;
      setTimeout(function() {
        var loading = document.getElementById('auth-loading');
        if (loading && !loading.classList.contains('hidden')) {
          console.warn('Module load timeout (' + timeout + 'ms) — showing login form');
          loading.classList.add('hidden');
          document.getElementById('auth-logged-out').classList.remove('hidden');
        }
      }, timeout);
    })();
  </script>
  <script type="module">
    import { BrowserOAuthClient } from 'https://esm.sh/@atproto/oauth-client-browser@0.3.16';

    const CLIENT_ID = '${clientId}';
    const REDIRECT_URI = '${redirectUri}';
    const ORIGIN = '${origin}';

    let oauthClient = null;
    let session = null;
    let currentSubject = null;
    let loadedNotes = [];
    let userRatings = {};

    // DOM elements
    const $ = (id) => document.getElementById(id);
    const authLoading = $('auth-loading');
    const authLoggedOut = $('auth-logged-out');
    const authLoggedIn = $('auth-logged-in');
    const messageEl = $('message');
    const notesSection = $('notes-section');
    const notesList = $('notes-list');
    const emptyNotes = $('empty-notes');
    const createNoteSection = $('create-note-section');

    function showMessage(text, type = 'error') {
      messageEl.textContent = text;
      messageEl.className = 'message message-' + type;
      messageEl.classList.remove('hidden');
      setTimeout(() => messageEl.classList.add('hidden'), 5000);
    }

    async function clearAtprotoStorage() {
      // Clear IndexedDB
      try {
        const dbs = await indexedDB.databases();
        for (const db of dbs) {
          if (db.name && db.name.includes('atproto')) {
            indexedDB.deleteDatabase(db.name);
            console.log('Cleared stale DB:', db.name);
          }
        }
      } catch (dbErr) {
        // indexedDB.databases() not supported — try known DB names
        for (const name of ['atproto-oauth-client', '@atproto/oauth-client-browser']) {
          try { indexedDB.deleteDatabase(name); } catch {}
        }
      }
      // Clear any related localStorage/sessionStorage
      try {
        for (const key of Object.keys(localStorage)) {
          if (key.includes('atproto') || key.includes('dpop')) {
            localStorage.removeItem(key);
          }
        }
        for (const key of Object.keys(sessionStorage)) {
          if (key.includes('atproto') || key.includes('dpop')) {
            sessionStorage.removeItem(key);
          }
        }
      } catch {}
    }

    function createOAuthClient() {
      return new BrowserOAuthClient({
        clientMetadata: {
          client_id: CLIENT_ID,
          client_name: 'Chorus',
          client_uri: ORIGIN,
          redirect_uris: [REDIRECT_URI],
          scope: 'atproto repo:site.filae.chorus.note repo:site.filae.chorus.rating',
          grant_types: ['authorization_code', 'refresh_token'],
          response_types: ['code'],
          token_endpoint_auth_method: 'none',
          application_type: 'web',
          dpop_bound_access_tokens: true,
        },
        handleResolver: 'https://bsky.social',
      });
    }

    async function initOAuth() {
      const isCallback = window.location.search.includes('code=') || window.location.search.includes('state=');
      console.log('[chorus] initOAuth start, isCallback:', isCallback, 'search:', window.location.search.substring(0, 80));

      try {
        oauthClient = createOAuthClient();

        // No timeout for callback — let the token exchange complete
        // Only timeout normal init (session restore from IndexedDB)
        let result;
        if (isCallback) {
          console.log('[chorus] Processing OAuth callback (no timeout)...');
          result = await oauthClient.init();
        } else {
          result = await Promise.race([
            oauthClient.init(),
            new Promise((_, reject) => setTimeout(() => reject(new Error('OAuth init timed out')), 5000)),
          ]);
        }

        console.log('[chorus] init result:', result ? 'got session' : 'no session');

        if (result?.session) {
          session = result.session;
          if (isCallback) {
            window.history.replaceState({}, '', '/');
          }
          showLoggedIn();
        } else {
          showLoggedOut();
        }
      } catch (e) {
        console.error('[chorus] OAuth init error:', e);

        if (isCallback) {
          // Callback failed — try once more with fresh client after clearing stale state
          console.log('[chorus] Callback failed, clearing storage and retrying...');
          await clearAtprotoStorage();
          try {
            oauthClient = createOAuthClient();
            const retryResult = await oauthClient.init();
            console.log('[chorus] Callback retry result:', retryResult ? 'got session' : 'no session');
            if (retryResult?.session) {
              session = retryResult.session;
              window.history.replaceState({}, '', '/');
              showLoggedIn();
              return;
            }
          } catch (retryErr) {
            console.error('[chorus] Callback retry failed:', retryErr);
          }
          // Callback exhausted — clean URL and show login
          window.history.replaceState({}, '', '/');
          showLoggedOut();
        } else {
          // Normal init failed — clear stale state and retry
          await clearAtprotoStorage();
          try {
            oauthClient = createOAuthClient();
            const retryResult = await Promise.race([
              oauthClient.init(),
              new Promise((_, reject) => setTimeout(() => reject(new Error('OAuth retry timed out')), 5000)),
            ]);
            if (retryResult?.session) {
              session = retryResult.session;
              showLoggedIn();
              return;
            }
          } catch (retryErr) {
            console.error('[chorus] Retry failed:', retryErr);
          }
          showLoggedOut();
        }
      }
    }

    function showLoggedOut() {
      authLoading.classList.add('hidden');
      authLoggedOut.classList.remove('hidden');
      authLoggedIn.classList.add('hidden');
      createNoteSection.classList.add('hidden');
    }

    async function showLoggedIn() {
      authLoading.classList.add('hidden');
      authLoggedOut.classList.add('hidden');
      authLoggedIn.classList.remove('hidden');

      const handle = await resolveDidToHandle(session.did);
      $('user-handle').textContent = '@' + handle;

      if (currentSubject) {
        createNoteSection.classList.remove('hidden');
      }
    }

    async function login() {
      const handle = $('handle-input').value.trim();
      if (!handle) return;

      try {
        $('login-btn').disabled = true;
        $('login-btn').textContent = 'Connecting...';
        await oauthClient.signIn(handle);
      } catch (e) {
        console.error('Login error:', e);
        showMessage('Failed to connect: ' + e.message);
        $('login-btn').disabled = false;
        $('login-btn').textContent = 'Connect';
      }
    }

    function logout() {
      session = null;
      showLoggedOut();
    }

    async function resolveDidToHandle(did) {
      try {
        const res = await fetch('https://plc.directory/' + did);
        if (res.ok) {
          const doc = await res.json();
          return doc.alsoKnownAs?.[0]?.replace('at://', '') || did;
        }
      } catch {}
      return did;
    }

    async function getPdsEndpoint(did) {
      try {
        const res = await fetch('https://plc.directory/' + did);
        if (res.ok) {
          const doc = await res.json();
          const endpoint = doc.service?.find(s => s.type === 'AtprotoPersonalDataServer');
          return endpoint?.serviceEndpoint || 'https://bsky.social';
        }
      } catch {}
      return 'https://bsky.social';
    }

    // Convert bsky.app URL to AT-URI
    function bskyUrlToAtUri(url) {
      const match = url.match(/bsky\\.app\\/profile\\/([^\\/]+)\\/post\\/([^\\/]+)/);
      if (!match) return null;
      const [, handle, rkey] = match;
      // We need to resolve handle to DID
      return { handle, rkey };
    }

    async function handleToAtUri(handle, rkey) {
      try {
        const res = await fetch('https://bsky.social/xrpc/com.atproto.identity.resolveHandle?handle=' + handle);
        if (res.ok) {
          const data = await res.json();
          return 'at://' + data.did + '/app.bsky.feed.post/' + rkey;
        }
      } catch {}
      return null;
    }

    async function searchNotes() {
      let input = $('subject-input').value.trim();
      if (!input) return;

      $('search-btn').disabled = true;
      $('search-btn').textContent = '...';

      try {
        // Convert bsky.app URL to AT-URI
        if (input.includes('bsky.app')) {
          const parts = bskyUrlToAtUri(input);
          if (parts) {
            const atUri = await handleToAtUri(parts.handle, parts.rkey);
            if (atUri) {
              input = atUri;
            } else {
              showMessage('Could not resolve handle: ' + parts.handle);
              return;
            }
          }
        }

        currentSubject = input;

        const res = await fetch('/api/notes?subject=' + encodeURIComponent(input));
        const data = await res.json();

        loadedNotes = data.notes || [];
        renderNotes();

        notesSection.classList.remove('hidden');
        if (session) {
          createNoteSection.classList.remove('hidden');
        }

      } catch (e) {
        console.error('Search error:', e);
        showMessage('Failed to search: ' + e.message);
      } finally {
        $('search-btn').disabled = false;
        $('search-btn').textContent = 'Search';
      }
    }

    function renderNotes() {
      notesList.innerHTML = '';
      $('note-count').textContent = loadedNotes.length;

      if (loadedNotes.length === 0) {
        emptyNotes.classList.remove('hidden');
        return;
      }

      emptyNotes.classList.add('hidden');

      for (const note of loadedNotes) {
        const div = document.createElement('div');
        div.className = 'note-item';
        div.dataset.uri = note.uri;

        const statusClass = 'status-' + note.stats.status;
        const statusLabel = note.stats.status.replace('_', ' ');
        const sources = note.sources || [];

        div.innerHTML = \`
          <div class="note-body">\${escapeHtml(note.body)}</div>
          <div class="note-meta">
            <span class="note-author">\${note.author.slice(0, 24)}...</span>
            <span class="note-status \${statusClass}">\${statusLabel}</span>
          </div>
          \${sources.length > 0 ? \`
            <div class="note-sources">
              ↳ \${sources.map(s => '<a href="' + s + '" target="_blank" rel="noopener">' + new URL(s).hostname + '</a>').join(' · ')}
            </div>
          \` : ''}
          \${session ? \`
            <div class="rating-buttons">
              <button class="rating-btn btn-secondary" data-uri="\${note.uri}" data-helpful="yes">Helpful</button>
              <button class="rating-btn btn-secondary" data-uri="\${note.uri}" data-helpful="somewhat">Somewhat</button>
              <button class="rating-btn btn-secondary" data-uri="\${note.uri}" data-helpful="no">Not Helpful</button>
            </div>
          \` : ''}
        \`;

        if (session) {
          div.querySelectorAll('.rating-btn').forEach(btn => {
            btn.addEventListener('click', () => rateNote(note.uri, btn.dataset.helpful));
          });
        }

        notesList.appendChild(div);
      }
    }

    function escapeHtml(str) {
      const div = document.createElement('div');
      div.textContent = str;
      return div.innerHTML;
    }

    async function submitNote() {
      if (!session || !currentSubject) return;

      const body = $('note-body').value.trim();
      if (!body) {
        showMessage('Please enter your note');
        return;
      }

      const sourcesText = $('note-sources').value.trim();
      const sources = sourcesText ? sourcesText.split('\\n').map(s => s.trim()).filter(Boolean) : [];

      $('submit-note-btn').disabled = true;
      $('submit-note-btn').textContent = 'Submitting...';

      try {
        const rkey = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

        const record = {
          $type: 'site.filae.chorus.note',
          subject: currentSubject,
          body: body,
          sources: sources.length > 0 ? sources : undefined,
          createdAt: new Date().toISOString(),
        };

        const pds = await getPdsEndpoint(session.did);

        const createRes = await session.fetchHandler(pds + '/xrpc/com.atproto.repo.createRecord', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            repo: session.did,
            collection: 'site.filae.chorus.note',
            rkey: rkey,
            record: record,
          }),
        });

        if (!createRes.ok) {
          const err = await createRes.text();
          throw new Error('Failed to create record: ' + err);
        }

        const createData = await createRes.json();

        // Index the note
        const indexRes = await fetch('/api/index/note', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ uri: createData.uri }),
        });

        if (!indexRes.ok) {
          throw new Error('Failed to index note');
        }

        showMessage('Note submitted!', 'success');
        $('note-body').value = '';
        $('note-sources').value = '';

        // Reload notes
        await searchNotes();

      } catch (e) {
        console.error('Submit error:', e);
        showMessage('Failed to submit: ' + e.message);
      } finally {
        $('submit-note-btn').disabled = false;
        $('submit-note-btn').textContent = 'Submit Note';
      }
    }

    async function rateNote(noteUri, helpful) {
      if (!session) return;

      try {
        const rkey = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

        const record = {
          $type: 'site.filae.chorus.rating',
          note: noteUri,
          helpful: helpful,
          createdAt: new Date().toISOString(),
        };

        const pds = await getPdsEndpoint(session.did);

        const createRes = await session.fetchHandler(pds + '/xrpc/com.atproto.repo.createRecord', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            repo: session.did,
            collection: 'site.filae.chorus.rating',
            rkey: rkey,
            record: record,
          }),
        });

        if (!createRes.ok) {
          throw new Error('Failed to create rating');
        }

        const createData = await createRes.json();

        // Index the rating
        await fetch('/api/index/rating', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ uri: createData.uri }),
        });

        // Update UI
        const noteEl = document.querySelector('[data-uri="' + noteUri + '"]');
        if (noteEl) {
          noteEl.querySelectorAll('.rating-btn').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.helpful === helpful);
          });
        }

        showMessage('Rating submitted!', 'success');

      } catch (e) {
        console.error('Rating error:', e);
        showMessage('Failed to rate: ' + e.message);
      }
    }

    async function loadStats() {
      try {
        const res = await fetch('/api/stats');
        const data = await res.json();
        $('stat-notes').textContent = data.notes.total;
        $('stat-certified').textContent = data.notes.certified;
        $('stat-raters').textContent = data.ratings.uniqueRaters;
      } catch (e) {
        console.error('Stats error:', e);
      }
    }

    // Typeahead for handle search
    let debounceTimer = null;
    let selectedIndex = -1;
    let currentResults = [];
    const handleInput = $('handle-input');
    const typeaheadDropdown = $('typeahead-dropdown');

    function escapeHtmlAttr(str) {
      return str.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
    }

    function hideTypeahead() {
      typeaheadDropdown.classList.remove('visible');
      selectedIndex = -1;
    }

    function selectHandle(handle) {
      handleInput.value = handle;
      hideTypeahead();
    }

    function renderTypeaheadResults() {
      typeaheadDropdown.innerHTML = currentResults.map((actor, i) => {
        const name = actor.displayName || actor.handle;
        return '<div class="typeahead-item' + (i === selectedIndex ? ' selected' : '') + '" data-handle="' + escapeHtmlAttr(actor.handle) + '">'
          + (actor.avatar
            ? '<img class="typeahead-avatar" src="' + escapeHtmlAttr(actor.avatar) + '" alt="" />'
            : '<div class="typeahead-avatar"></div>')
          + '<div class="typeahead-info">'
          + '<div class="typeahead-name">' + escapeHtml(name) + '</div>'
          + '<div class="typeahead-handle">@' + escapeHtml(actor.handle) + '</div>'
          + '</div></div>';
      }).join('');
    }

    function searchHandles(query) {
      if (debounceTimer) clearTimeout(debounceTimer);

      if (!query || query.length < 2) {
        hideTypeahead();
        return;
      }

      debounceTimer = setTimeout(async () => {
        typeaheadDropdown.innerHTML = '<div class="typeahead-loading">Searching...</div>';
        typeaheadDropdown.classList.add('visible');

        try {
          const res = await fetch(
            'https://public.api.bsky.app/xrpc/app.bsky.actor.searchActorsTypeahead?q='
            + encodeURIComponent(query) + '&limit=8'
          );

          if (!res.ok) throw new Error('Search failed');

          const data = await res.json();
          currentResults = (data.actors || []).map(actor => ({
            handle: actor.handle,
            displayName: actor.displayName,
            avatar: actor.avatar,
          }));
          selectedIndex = -1;

          if (currentResults.length === 0) {
            typeaheadDropdown.innerHTML = '<div class="typeahead-empty">No matches. Enter handle manually.</div>';
            return;
          }

          renderTypeaheadResults();
        } catch (err) {
          console.error('Typeahead error:', err);
          typeaheadDropdown.innerHTML = '<div class="typeahead-empty">Search failed. Enter handle manually.</div>';
        }
      }, 150);
    }

    handleInput.addEventListener('input', (e) => {
      const value = e.target.value.trim().replace(/^@/, '');
      searchHandles(value);
    });

    handleInput.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (currentResults.length > 0) {
          selectedIndex = Math.min(selectedIndex + 1, currentResults.length - 1);
          renderTypeaheadResults();
        }
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        if (currentResults.length > 0) {
          selectedIndex = Math.max(selectedIndex - 1, -1);
          renderTypeaheadResults();
        }
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (selectedIndex >= 0 && currentResults[selectedIndex]) {
          selectHandle(currentResults[selectedIndex].handle);
        }
        hideTypeahead();
        login();
      } else if (e.key === 'Escape') {
        hideTypeahead();
      }
    });

    typeaheadDropdown.addEventListener('click', (e) => {
      const item = e.target.closest('.typeahead-item');
      if (item && item.dataset.handle) {
        selectHandle(item.dataset.handle);
        login();
      }
    });

    document.addEventListener('click', (e) => {
      if (!e.target.closest('.handle-input-wrapper')) {
        hideTypeahead();
      }
    });

    // Event listeners
    $('login-btn').addEventListener('click', login);
    $('logout-btn').addEventListener('click', logout);
    $('search-btn').addEventListener('click', searchNotes);
    $('subject-input').addEventListener('keypress', e => { if (e.key === 'Enter') searchNotes(); });
    $('submit-note-btn').addEventListener('click', submitNote);

    // Initialize
    loadStats();
    initOAuth();
  </script>
</body>
</html>`;
}

// =============================================================================
// Export
// =============================================================================

export default {
  fetch: app.fetch,
  scheduled,
};
