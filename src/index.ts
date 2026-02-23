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

// OAuth callback page
app.get('/oauth/callback', (c) => {
  return c.html(`<!DOCTYPE html>
<html><head><title>Chorus - Redirecting...</title></head>
<body><p>Completing sign-in...</p>
<script>window.location.href = '/' + window.location.hash;</script>
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
  <title>Chorus - Community Notes on ATProto</title>
  <style>
    :root {
      --bg: #1a1a2e;
      --surface: #16213e;
      --border: #0f3460;
      --text: #e2e2e2;
      --text-muted: #a0a0a0;
      --accent: #e94560;
      --accent-hover: #ff6b6b;
      --certified: #4ade80;
      --pending: #fbbf24;
      --needs-more: #60a5fa;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: var(--bg);
      color: var(--text);
      min-height: 100vh;
      padding: 20px;
    }
    .container { max-width: 800px; margin: 0 auto; }
    header {
      text-align: center;
      margin-bottom: 30px;
      padding-bottom: 20px;
      border-bottom: 1px solid var(--border);
    }
    h1 { color: var(--accent); margin-bottom: 8px; }
    .subtitle { color: var(--text-muted); font-size: 0.95rem; }

    /* Auth section */
    .auth-section {
      background: var(--surface);
      padding: 20px;
      border-radius: 8px;
      margin-bottom: 20px;
      border: 1px solid var(--border);
    }
    .auth-logged-in { display: flex; justify-content: space-between; align-items: center; }
    .auth-logged-in .handle { color: var(--accent); }

    /* Search */
    .search-section {
      background: var(--surface);
      padding: 20px;
      border-radius: 8px;
      margin-bottom: 20px;
      border: 1px solid var(--border);
    }
    .search-section label { display: block; margin-bottom: 8px; color: var(--text-muted); }
    .search-row { display: flex; gap: 10px; }
    .search-row input {
      flex: 1;
      padding: 10px 14px;
      border: 1px solid var(--border);
      border-radius: 6px;
      background: var(--bg);
      color: var(--text);
      font-size: 14px;
    }
    .search-row input:focus { outline: none; border-color: var(--accent); }

    /* Buttons */
    button {
      padding: 10px 18px;
      border: none;
      border-radius: 6px;
      cursor: pointer;
      font-size: 14px;
      transition: background 0.2s;
    }
    .btn-primary { background: var(--accent); color: white; }
    .btn-primary:hover { background: var(--accent-hover); }
    .btn-secondary { background: var(--surface); color: var(--text); border: 1px solid var(--border); }
    .btn-secondary:hover { background: var(--border); }
    button:disabled { opacity: 0.5; cursor: not-allowed; }

    /* Notes list */
    .notes-section {
      background: var(--surface);
      padding: 20px;
      border-radius: 8px;
      border: 1px solid var(--border);
      margin-bottom: 20px;
    }
    .notes-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 15px;
    }
    .notes-header h2 { font-size: 1.1rem; }
    .note-count { color: var(--text-muted); font-size: 0.9rem; }

    .note-item {
      background: var(--bg);
      padding: 15px;
      border-radius: 6px;
      margin-bottom: 12px;
      border: 1px solid var(--border);
    }
    .note-body { margin-bottom: 10px; line-height: 1.5; }
    .note-meta {
      display: flex;
      justify-content: space-between;
      align-items: center;
      font-size: 0.85rem;
      color: var(--text-muted);
    }
    .note-status {
      padding: 3px 8px;
      border-radius: 4px;
      font-size: 0.8rem;
      font-weight: 500;
    }
    .status-certified { background: var(--certified); color: #000; }
    .status-pending { background: var(--pending); color: #000; }
    .status-needs_more { background: var(--needs-more); color: #000; }
    .status-rejected { background: #ef4444; color: white; }

    .note-sources {
      margin-top: 10px;
      padding-top: 10px;
      border-top: 1px solid var(--border);
    }
    .note-sources a { color: var(--accent); text-decoration: none; font-size: 0.85rem; }
    .note-sources a:hover { text-decoration: underline; }

    /* Rating buttons */
    .rating-buttons {
      display: flex;
      gap: 8px;
      margin-top: 10px;
    }
    .rating-btn {
      padding: 6px 12px;
      font-size: 0.8rem;
    }
    .rating-btn.active { background: var(--accent); color: white; }

    /* Create note form */
    .create-note-section {
      background: var(--surface);
      padding: 20px;
      border-radius: 8px;
      border: 1px solid var(--border);
      margin-bottom: 20px;
    }
    .create-note-section h3 { margin-bottom: 15px; }
    .form-group { margin-bottom: 15px; }
    .form-group label { display: block; margin-bottom: 6px; color: var(--text-muted); font-size: 0.9rem; }
    .form-group textarea, .form-group input[type="text"] {
      width: 100%;
      padding: 10px;
      border: 1px solid var(--border);
      border-radius: 6px;
      background: var(--bg);
      color: var(--text);
      font-size: 14px;
      font-family: inherit;
    }
    .form-group textarea { min-height: 100px; resize: vertical; }

    /* Stats */
    .stats-section {
      background: var(--surface);
      padding: 15px 20px;
      border-radius: 8px;
      border: 1px solid var(--border);
      margin-bottom: 20px;
      display: flex;
      gap: 30px;
      font-size: 0.9rem;
    }
    .stat-item { color: var(--text-muted); }
    .stat-item strong { color: var(--text); }

    /* Empty state */
    .empty-state {
      text-align: center;
      padding: 40px;
      color: var(--text-muted);
    }

    /* Messages */
    .message {
      padding: 12px 16px;
      border-radius: 6px;
      margin-bottom: 15px;
    }
    .message-error { background: #7f1d1d; color: #fca5a5; }
    .message-success { background: #14532d; color: #86efac; }

    /* Login form */
    .login-form { display: flex; gap: 10px; }
    .login-form input {
      flex: 1;
      padding: 10px 14px;
      border: 1px solid var(--border);
      border-radius: 6px;
      background: var(--bg);
      color: var(--text);
    }

    .hidden { display: none !important; }

    /* Info */
    .info-box {
      background: var(--border);
      padding: 15px;
      border-radius: 6px;
      margin-bottom: 15px;
      font-size: 0.9rem;
      line-height: 1.5;
    }
    .info-box strong { color: var(--accent); }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <h1>🎵 Chorus</h1>
      <p class="subtitle">Community Notes on ATProto — bridging-based consensus</p>
    </header>

    <div id="message" class="hidden"></div>

    <!-- Auth Section -->
    <div class="auth-section">
      <div id="auth-loading">Initializing...</div>
      <div id="auth-logged-out" class="hidden">
        <div class="login-form">
          <input type="text" id="handle-input" placeholder="Enter your handle (e.g. alice.bsky.social)" />
          <button id="login-btn" class="btn-primary">Sign In</button>
        </div>
      </div>
      <div id="auth-logged-in" class="auth-logged-in hidden">
        <span>Signed in as <span class="handle" id="user-handle"></span></span>
        <button id="logout-btn" class="btn-secondary">Sign Out</button>
      </div>
    </div>

    <!-- Stats -->
    <div id="stats-section" class="stats-section">
      <div class="stat-item">Notes: <strong id="stat-notes">-</strong></div>
      <div class="stat-item">Certified: <strong id="stat-certified">-</strong></div>
      <div class="stat-item">Raters: <strong id="stat-raters">-</strong></div>
    </div>

    <!-- Search Section -->
    <div class="search-section">
      <label>Look up notes on a Bluesky post</label>
      <div class="search-row">
        <input type="text" id="subject-input" placeholder="Paste Bluesky post URL (e.g. https://bsky.app/profile/handle/post/xyz)" />
        <button id="search-btn" class="btn-primary">Search</button>
      </div>
    </div>

    <!-- Notes Section (shown after search) -->
    <div id="notes-section" class="notes-section hidden">
      <div class="notes-header">
        <h2>Notes on this post</h2>
        <span class="note-count" id="note-count"></span>
      </div>
      <div id="notes-list"></div>
      <div id="empty-notes" class="empty-state hidden">
        No notes yet. Be the first to add context!
      </div>
    </div>

    <!-- Create Note Section (shown after search, if logged in) -->
    <div id="create-note-section" class="create-note-section hidden">
      <h3>Add a note</h3>
      <div class="info-box">
        <strong>How notes work:</strong> Your note will be reviewed by other users.
        Notes that receive positive ratings from people with <em>diverse perspectives</em>
        get certified. Partisan notes that only appeal to one viewpoint don't make the cut.
      </div>
      <div class="form-group">
        <label>Your note</label>
        <textarea id="note-body" placeholder="Add helpful context, fact-checks, or clarifications..."></textarea>
      </div>
      <div class="form-group">
        <label>Sources (optional, one URL per line)</label>
        <textarea id="note-sources" placeholder="https://example.com/source1&#10;https://example.com/source2" style="min-height: 60px;"></textarea>
      </div>
      <button id="submit-note-btn" class="btn-primary">Submit Note</button>
    </div>
  </div>

  <script type="module">
    import { BrowserOAuthClient } from 'https://esm.sh/@atproto/oauth-client-browser@0.3.17';

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

    async function initOAuth() {
      try {
        oauthClient = new BrowserOAuthClient({
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

        const result = await oauthClient.init();

        if (result?.session) {
          session = result.session;
          showLoggedIn();
        } else {
          showLoggedOut();
        }
      } catch (e) {
        console.error('OAuth init error:', e);
        showLoggedOut();
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
        $('login-btn').textContent = 'Signing in...';
        await oauthClient.signIn(handle);
      } catch (e) {
        console.error('Login error:', e);
        showMessage('Failed to sign in: ' + e.message);
        $('login-btn').disabled = false;
        $('login-btn').textContent = 'Sign In';
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
      $('search-btn').textContent = 'Searching...';

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
      $('note-count').textContent = loadedNotes.length + ' note(s)';

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
        const sources = note.sources || [];

        div.innerHTML = \`
          <div class="note-body">\${escapeHtml(note.body)}</div>
          <div class="note-meta">
            <span>by \${note.author.slice(0, 20)}...</span>
            <span class="note-status \${statusClass}">\${note.stats.status}</span>
          </div>
          \${sources.length > 0 ? \`
            <div class="note-sources">
              Sources: \${sources.map(s => '<a href="' + s + '" target="_blank" rel="noopener">' + new URL(s).hostname + '</a>').join(', ')}
            </div>
          \` : ''}
          \${session ? \`
            <div class="rating-buttons">
              <button class="rating-btn btn-secondary" data-uri="\${note.uri}" data-helpful="yes">👍 Helpful</button>
              <button class="rating-btn btn-secondary" data-uri="\${note.uri}" data-helpful="somewhat">🤔 Somewhat</button>
              <button class="rating-btn btn-secondary" data-uri="\${note.uri}" data-helpful="no">👎 Not helpful</button>
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

    // Event listeners
    $('login-btn').addEventListener('click', login);
    $('handle-input').addEventListener('keypress', e => { if (e.key === 'Enter') login(); });
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
