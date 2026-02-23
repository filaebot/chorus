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

// Health check
app.get('/', (c) => {
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
// Export
// =============================================================================

export default {
  fetch: app.fetch,
  scheduled,
};
