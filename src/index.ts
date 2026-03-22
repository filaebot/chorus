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
  runBridgingAlgorithm2D,
  certifyNotes2D,
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
    redirect_uris: [`${origin}/`],
    scope: 'atproto repo:site.filae.chorus.note repo:site.filae.chorus.rating',
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
    application_type: 'web',
    dpop_bound_access_tokens: true,
  });
});

// OAuth callback page — legacy fallback. Primary redirect_uri is now '/'.
// Auth server may still redirect here if client metadata was cached, so forward to root.
app.get('/oauth/callback', (c) => {
  return c.html(`<!DOCTYPE html>
<html><head><title>Chorus - Redirecting...</title></head>
<body><p>Completing sign-in...</p>
<script>
  // Collect params from both query string and hash fragment
  var params = new URLSearchParams(window.location.search);
  if (window.location.hash && window.location.hash.length > 1) {
    var hashParams = new URLSearchParams(window.location.hash.substring(1));
    hashParams.forEach(function(v, k) { if (!params.has(k)) params.set(k, v); });
  }
  var qs = params.toString();
  window.location.href = '/' + (qs ? '?' + qs : '');
</script>
</body></html>`);
});

// A2A Agent Card (standard agent discovery)
app.get('/.well-known/agent.json', (c) => {
  const origin = new URL(c.req.url).origin;
  return c.json({
    name: "Chorus",
    description: "ATProto-native community notes with bridging-based consensus. Annotate any AT-URI with context, fact-checks, or clarifications. Notes get certified when rated helpful by users with diverse perspectives.",
    url: origin,
    version: "2.0.0",
    provider: {
      organization: "Filae",
      url: "https://filae.site"
    },
    documentationUrl: `${origin}/.well-known/atproto-capabilities`,
    capabilities: {
      streaming: false,
      pushNotifications: false,
    },
    defaultInputModes: ["application/json"],
    defaultOutputModes: ["application/json", "text/html"],
    skills: [
      {
        id: "read-notes",
        name: "Read Community Notes",
        description: "Get all community notes for a given AT-URI (post, profile, etc.). Returns notes with their certification status.",
        tags: ["read", "community-notes", "atproto"],
        examples: ["GET /api/notes?subject=at://did/app.bsky.feed.post/rkey"],
      },
      {
        id: "read-certified",
        name: "Read Certified Notes",
        description: "Get only certified (bridging-consensus) notes for a given AT-URI. These notes have been rated helpful by users with diverse perspectives.",
        tags: ["read", "certified", "bridging"],
        examples: ["GET /api/certified?subject=at://..."],
      },
      {
        id: "create-note",
        name: "Create Community Note",
        description: "Annotate any AT-URI with context or fact-check. Two-step: (1) create ATProto record on PDS, (2) POST /api/index/note to register with Chorus. Open to all ATProto users.",
        tags: ["write", "annotate", "atproto"],
        examples: ["POST /api/index/note {uri: 'at://did/site.filae.chorus.note/rkey'}"],
      },
      {
        id: "rate-note",
        name: "Rate a Note",
        description: "Rate how helpful a community note is (yes/somewhat/no). Two-step ATProto pattern. Ratings from diverse perspectives determine certification.",
        tags: ["write", "rate", "consensus"],
        examples: ["POST /api/index/rating {uri: 'at://did/site.filae.chorus.rating/rkey'}"],
      },
      {
        id: "stats",
        name: "System Statistics",
        description: "Get overall system stats: note count, rating count, certified count.",
        tags: ["read", "stats"],
        examples: ["GET /api/stats"],
      }
    ],
    securitySchemes: {
      atprotoOAuth: {
        type: "oauth2",
        description: "ATProto OAuth with DPoP. Client metadata at /oauth/client-metadata.json."
      }
    },
    extensions: {
      atproto: {
        did: "did:plc:dcb6ifdsru63appkbffy3foy",
        lexicons: ["site.filae.chorus.note", "site.filae.chorus.rating"],
        capabilityManifest: `${origin}/.well-known/atproto-capabilities`,
        membership: "open",
        algorithm: "2D bridging-based matrix factorization with entropy-based axis rotation",
        dataOwnership: "Notes and ratings stored on user PDSes. Chorus indexes and runs the certification algorithm."
      }
    }
  });
});

// Capability manifest for agent discovery (ATProto-specific)
app.get('/.well-known/atproto-capabilities', (c) => {
  const origin = new URL(c.req.url).origin;
  return c.json({
    "@context": "https://atproto.com/capabilities/v1",
    name: "Chorus",
    description: "ATProto-native community notes with bridging-based consensus. Anyone can annotate any AT-URI (posts, profiles, etc.) with context, fact-checks, or clarifications. Notes get certified when rated helpful by users with diverse perspectives.",
    url: origin,
    did: "did:plc:dcb6ifdsru63appkbffy3foy",
    protocol: "atproto",

    lexicons: [
      {
        lexicon: 1,
        id: "site.filae.chorus.note",
        defs: {
          main: {
            type: "record",
            description: "A community note/annotation on any AT-URI",
            key: "tid",
            record: {
              type: "object",
              required: ["subject", "body", "createdAt"],
              properties: {
                subject: { type: "string", format: "at-uri", description: "The AT-URI being annotated (post, profile, etc.)" },
                body: { type: "string", maxLength: 2000, maxGraphemes: 1000, description: "The note content - context, clarification, fact-check" },
                sources: { type: "array", maxLength: 5, items: { type: "string", format: "uri", maxLength: 500 }, description: "Optional supporting source URLs" },
                createdAt: { type: "string", format: "datetime" }
              }
            }
          }
        }
      },
      {
        lexicon: 1,
        id: "site.filae.chorus.rating",
        defs: {
          main: {
            type: "record",
            description: "A rating on a community note",
            key: "tid",
            record: {
              type: "object",
              required: ["note", "helpful", "createdAt"],
              properties: {
                note: { type: "string", format: "at-uri", description: "The note being rated" },
                helpful: { type: "string", enum: ["yes", "somewhat", "no"], description: "How helpful is this note? Maps to 1.0/0.5/0.0" },
                tags: { type: "array", maxLength: 5, items: { type: "string", maxLength: 50, knownValues: ["clear", "sourced", "balanced", "timely", "misleading", "biased", "outdated", "irrelevant"] }, description: "Optional qualitative tags" },
                createdAt: { type: "string", format: "datetime" }
              }
            }
          }
        }
      }
    ],

    auth: {
      method: "atproto-oauth",
      dpop: true,
      scope: "atproto repo:site.filae.chorus.note repo:site.filae.chorus.rating",
      clientMetadata: `${origin}/oauth/client-metadata.json`,
      note: "Auth required only for creating notes and ratings. All read endpoints are public."
    },

    membership: {
      type: "open",
      description: "No membership required. Anyone with an ATProto account can create notes and ratings."
    },

    read: {
      notes: { method: "GET", path: "/api/notes", query: { subject: "at-uri" }, description: "Get all notes for a given AT-URI" },
      certified: { method: "GET", path: "/api/certified", query: { subject: "at-uri" }, description: "Get only certified (bridging-consensus) notes for a given AT-URI" },
      note: { method: "GET", path: "/api/note/:did/:rkey", description: "Get a specific note with its ratings and status" },
      stats: { method: "GET", path: "/api/stats", description: "System statistics: note count, rating count, certified count" }
    },

    write: {
      note: {
        create: {
          description: "Create a community note on any AT-URI. Two-step: (1) create ATProto record, (2) index with Chorus.",
          steps: [
            {
              step: 1,
              action: "Create ATProto record",
              method: "POST",
              url: "https://bsky.social/xrpc/com.atproto.repo.createRecord",
              body: {
                repo: "<user-did>",
                collection: "site.filae.chorus.note",
                record: { subject: "at-uri", body: "string", sources: "?string[]", createdAt: "datetime" }
              }
            },
            {
              step: 2,
              action: "Index with Chorus",
              method: "POST",
              path: "/api/index/note",
              body: { uri: "<at-uri from step 1>", did: "<user-did>" }
            }
          ]
        }
      },
      rating: {
        create: {
          description: "Rate a community note. Same two-step pattern.",
          steps: [
            {
              step: 1,
              action: "Create ATProto record",
              method: "POST",
              url: "https://bsky.social/xrpc/com.atproto.repo.createRecord",
              body: {
                repo: "<user-did>",
                collection: "site.filae.chorus.rating",
                record: { note: "at-uri (the note)", helpful: "yes|somewhat|no", tags: "?string[]", createdAt: "datetime" }
              }
            },
            {
              step: 2,
              action: "Index with Chorus",
              method: "POST",
              path: "/api/index/rating",
              body: { uri: "<at-uri from step 1>", did: "<user-did>" }
            }
          ]
        }
      }
    },

    algorithm: {
      name: "2D Bridging-Based Consensus",
      description: "Notes are certified when rated helpful by users with diverse perspectives. Uses 2D matrix factorization with entropy-based axis rotation to separate common ground from polarity. Resists coordinated attack patterns.",
      schedule: "Runs every 5 minutes via cron trigger",
      certification: {
        criteria: "commonGround > 0.35 AND |polarity| < 0.5 AND ratings >= 5",
        description: "A note must achieve positive common ground score (helpful across diverse raters), low polarity (not just one faction), and a minimum number of ratings."
      }
    },

    agentGuidance: {
      quickStart: "To annotate a post: (1) authenticate via ATProto, (2) create a site.filae.chorus.note record on your PDS with the target post's AT-URI as subject, (3) POST /api/index/note to register it with Chorus. To check existing notes on a post: GET /api/notes?subject=at://did/collection/rkey",
      dataOwnership: "All notes and ratings are stored as ATProto records on users' PDSes. Chorus D1 is an index for aggregation and algorithm computation.",
      certificationProcess: "Notes start as 'needs_more_ratings'. The bridging algorithm runs every 5 minutes and evaluates all notes with sufficient ratings. Certified notes have been rated helpful by users who otherwise disagree — the 'bridging' signal."
    }
  }, 200, {
    'Cache-Control': 'public, max-age=3600'
  });
});

// Main UI
app.get('/', (c) => {
  const origin = new URL(c.req.url).origin;
  c.header('Cache-Control', 'no-cache, no-store, must-revalidate');
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

    // Run 2D bridging algorithm with entropy-based axis rotation
    const params = runBridgingAlgorithm2D(ratings, 20);

    // Get rating counts per note
    const ratingCounts = new Map<string, number>();
    for (const r of ratings) {
      ratingCounts.set(r.noteId, (ratingCounts.get(r.noteId) || 0) + 1);
    }

    // Get average ratings
    const avgRatings = computeAverageRatings(ratings);

    // Certify notes using 2D projections
    const noteStatuses = certifyNotes2D(params, ratingCounts);

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

    // Update rater profiles (project 2D factors onto polarity axis for storage)
    for (const [did, factor2d] of params.userFactors) {
      const intercept = params.userIntercepts.get(did) || 0;
      const ratingCount = ratings.filter((r) => r.userId === did).length;
      // Store polarity projection as the scalar factor
      const factor = factor2d[0] * params.polarityAxis[0] + factor2d[1] * params.polarityAxis[1];

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
  const redirectUri = `${origin}/`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>CHORUS — Community Notes</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=Instrument+Serif:ital@0;1&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg: #0B0F14;
      --surface: #131921;
      --surface-elevated: #1B2332;
      --border: rgba(136, 153, 171, 0.15);
      --text: #E8ECF1;
      --text-muted: #8899AB;
      --accent: #4ECDC4;
      --accent-hover: #5DDDD4;
      --accent-subtle: rgba(78, 205, 196, 0.1);
      --certified: #4ECDC4;
      --certified-glow: rgba(78, 205, 196, 0.25);
      --pending: #8899AB;
      --needs-more: #E8B84D;
      --not-helpful: #E85D75;
      --sans: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
      --serif: 'Instrument Serif', Georgia, serif;
    }

    * { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      font-family: var(--sans);
      background: var(--bg);
      color: var(--text);
      min-height: 100vh;
      font-size: 15px;
      line-height: 1.6;
      -webkit-font-smoothing: antialiased;
      -moz-osx-font-smoothing: grayscale;
    }

    ::selection {
      background: var(--accent);
      color: var(--bg);
    }

    /* LAYOUT */
    .container {
      max-width: 640px;
      margin: 0 auto;
      padding: 0 20px;
    }

    /* HERO */
    .hero {
      padding: 80px 0 64px;
      text-align: center;
    }

    .logo {
      font-family: var(--serif);
      font-size: clamp(5rem, 14vw, 9rem);
      font-weight: 400;
      letter-spacing: -0.02em;
      line-height: 0.9;
      color: var(--text);
    }

    .tagline {
      font-family: var(--sans);
      font-size: 12px;
      font-weight: 500;
      text-transform: uppercase;
      letter-spacing: 0.2em;
      color: var(--text-muted);
      margin-top: 20px;
    }

    .hero-stats {
      font-family: var(--sans);
      font-size: 14px;
      color: var(--text-muted);
      margin-top: 16px;
      letter-spacing: 0.01em;
    }

    .hero-stats span {
      color: var(--text);
      font-weight: 500;
    }

    /* AUTH — top bar when logged in, inline when logged out */
    .auth-bar {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 12px;
      padding: 16px 0;
      font-size: 14px;
      color: var(--text-muted);
    }

    .handle {
      color: var(--accent);
      font-weight: 500;
    }

    .auth-bar .btn-text {
      color: var(--text-muted);
      font-size: 13px;
    }

    .auth-bar .btn-text:hover {
      color: var(--text);
    }

    .login-form {
      display: flex;
      gap: 12px;
      align-items: stretch;
      max-width: 420px;
      margin: 0 auto;
    }

    .handle-input-wrapper {
      flex: 1;
      position: relative;
    }

    /* INPUTS */
    input[type="text"], textarea {
      width: 100%;
      padding: 12px 0;
      border: none;
      border-bottom: 1px solid var(--border);
      background: transparent;
      color: var(--text);
      font-family: var(--sans);
      font-size: 16px;
      transition: border-color 0.3s ease;
    }

    input[type="text"]:focus, textarea:focus {
      outline: none;
      border-bottom-color: var(--accent);
    }

    input::placeholder, textarea::placeholder {
      color: var(--text-muted);
      opacity: 0.5;
    }

    textarea {
      min-height: 100px;
      resize: vertical;
      line-height: 1.6;
    }

    /* BUTTONS */
    button {
      font-family: var(--sans);
      font-size: 14px;
      font-weight: 500;
      padding: 10px 20px;
      border: none;
      background: transparent;
      color: var(--accent);
      cursor: pointer;
      transition: color 0.2s ease, opacity 0.2s ease;
      white-space: nowrap;
    }

    button:hover {
      color: var(--accent-hover);
    }

    button:disabled {
      opacity: 0.3;
      cursor: not-allowed;
    }

    .btn-primary {
      background: transparent;
      color: var(--accent);
      font-weight: 600;
    }

    .btn-primary:hover {
      color: var(--accent-hover);
    }

    .btn-secondary {
      color: var(--text-muted);
    }

    .btn-secondary:hover {
      color: var(--text);
    }

    .btn-text {
      padding: 0;
      font-size: 13px;
      color: var(--text-muted);
    }

    .btn-text:hover {
      color: var(--text);
    }

    /* SEARCH */
    .search-section {
      padding-bottom: 48px;
    }

    .search-row {
      display: flex;
      gap: 8px;
      align-items: flex-end;
    }

    .search-row input {
      flex: 1;
    }

    .search-row button {
      min-width: 70px;
      padding-bottom: 12px;
    }

    /* DIVIDER */
    .divider {
      height: 1px;
      background: var(--border);
      margin: 0;
    }

    /* NOTES */
    .notes-header {
      display: flex;
      justify-content: space-between;
      align-items: baseline;
      padding: 48px 0 24px;
    }

    .notes-title {
      font-family: var(--serif);
      font-size: 24px;
      font-style: italic;
      color: var(--text);
    }

    .note-count {
      font-size: 13px;
      color: var(--text-muted);
    }

    @keyframes fadeIn {
      from { opacity: 0; transform: translateY(8px); }
      to { opacity: 1; transform: translateY(0); }
    }

    .note-item {
      padding: 28px 0;
      border-bottom: 1px solid var(--border);
      animation: fadeIn 0.4s ease both;
    }

    .note-item:last-child {
      border-bottom: none;
    }

    .note-body {
      font-family: var(--serif);
      font-size: 18px;
      line-height: 1.7;
      color: var(--text);
    }

    .note-meta {
      display: flex;
      align-items: center;
      gap: 16px;
      margin-top: 12px;
      font-size: 13px;
      color: var(--text-muted);
    }

    .note-author {
      font-family: var(--sans);
      font-size: 12px;
      letter-spacing: 0.02em;
    }

    /* STATUS — dot + text */
    .note-status {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      font-size: 12px;
      font-family: var(--sans);
      font-weight: 500;
      text-transform: capitalize;
    }

    .note-status::before {
      content: '';
      display: inline-block;
      width: 6px;
      height: 6px;
      border-radius: 50%;
      flex-shrink: 0;
    }

    .status-certified {
      color: var(--certified);
    }
    .status-certified::before {
      background: var(--certified);
      box-shadow: 0 0 6px var(--certified-glow);
      animation: pulse 2.5s ease-in-out infinite;
    }

    .status-pending {
      color: var(--pending);
    }
    .status-pending::before {
      background: var(--pending);
    }

    .status-needs_more {
      color: var(--needs-more);
    }
    .status-needs_more::before {
      background: var(--needs-more);
    }

    .status-rejected, .status-not_helpful {
      color: var(--not-helpful);
    }
    .status-rejected::before, .status-not_helpful::before {
      background: var(--not-helpful);
    }

    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.5; }
    }

    .note-sources {
      margin-top: 10px;
      font-size: 13px;
      font-family: var(--sans);
      color: var(--text-muted);
    }

    .note-sources a {
      color: var(--accent);
      text-decoration: none;
      transition: opacity 0.2s;
    }

    .note-sources a:hover {
      opacity: 0.8;
      text-decoration: underline;
    }

    /* RATING BUTTONS */
    .rating-buttons {
      display: flex;
      gap: 16px;
      margin-top: 14px;
    }

    .rating-btn {
      font-size: 13px;
      font-weight: 400;
      color: var(--text-muted);
      padding: 4px 0;
      min-height: 44px;
      display: flex;
      align-items: center;
    }

    .rating-btn:hover {
      color: var(--text);
    }

    .rating-btn.active {
      color: var(--accent);
      font-weight: 600;
    }

    /* EMPTY STATE */
    .empty-state {
      text-align: center;
      padding: 60px 0;
      color: var(--text-muted);
      font-family: var(--serif);
      font-style: italic;
      font-size: 17px;
    }

    /* MESSAGES */
    .message {
      padding: 12px 16px;
      margin-bottom: 24px;
      font-size: 14px;
      border-radius: 4px;
    }

    .message-error {
      background: rgba(232, 93, 117, 0.1);
      color: var(--not-helpful);
    }

    .message-success {
      background: var(--accent-subtle);
      color: var(--accent);
    }

    /* CREATE NOTE */
    .create-section {
      padding: 48px 0 80px;
    }

    .create-section .section-title {
      font-family: var(--serif);
      font-size: 22px;
      font-style: italic;
      margin-bottom: 8px;
    }

    .create-hint {
      font-size: 14px;
      color: var(--text-muted);
      line-height: 1.6;
      margin-bottom: 28px;
    }

    .create-hint em {
      font-family: var(--serif);
      font-style: italic;
      color: var(--text);
    }

    .form-group {
      margin-bottom: 24px;
    }

    .form-label {
      display: block;
      margin-bottom: 8px;
      font-size: 11px;
      font-weight: 500;
      text-transform: uppercase;
      letter-spacing: 0.1em;
      color: var(--text-muted);
    }

    /* TYPEAHEAD */
    .typeahead-dropdown {
      display: none;
      position: absolute;
      top: 100%;
      left: 0;
      right: 0;
      background: var(--surface-elevated);
      border: 1px solid var(--border);
      border-top: none;
      border-radius: 0 0 6px 6px;
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
      padding: 10px 14px;
      cursor: pointer;
      transition: background 0.15s;
      min-height: 44px;
    }

    .typeahead-item:hover,
    .typeahead-item.selected {
      background: var(--accent-subtle);
    }

    .typeahead-avatar {
      width: 32px;
      height: 32px;
      border-radius: 50%;
      object-fit: cover;
      background: var(--surface);
      flex-shrink: 0;
    }

    .typeahead-info {
      min-width: 0;
      flex: 1;
    }

    .typeahead-name {
      font-size: 14px;
      color: var(--text);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .typeahead-handle {
      font-size: 12px;
      color: var(--text-muted);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .typeahead-loading,
    .typeahead-empty {
      padding: 14px;
      font-size: 13px;
      color: var(--text-muted);
      text-align: center;
    }

    .hidden { display: none !important; }

    /* RESPONSIVE */
    @media (max-width: 600px) {
      .hero { padding: 48px 0 40px; }
      .search-row { flex-direction: column; gap: 0; }
      .search-row button { align-self: flex-end; }
      .login-form { flex-direction: column; gap: 8px; }
      .rating-buttons { gap: 12px; }
    }
  </style>
</head>
<body>
  <div class="container">
    <!-- Hero -->
    <div class="hero">
      <div class="logo">CHORUS</div>
      <p class="tagline">Community notes with bridging-based consensus</p>
      <p class="hero-stats"><span id="stat-notes">&mdash;</span> notes &middot; <span id="stat-certified">&mdash;</span> certified &middot; <span id="stat-raters">&mdash;</span> contributors</p>
    </div>

    <!-- Auth -->
    <div class="auth-bar">
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
      <div id="auth-logged-in" class="hidden">
        <span>Signed in as <span class="handle" id="user-handle"></span></span>
        <button id="logout-btn" class="btn-text">Disconnect</button>
      </div>
    </div>

    <div class="divider"></div>

    <div id="message" class="hidden"></div>

    <!-- Search -->
    <div class="search-section" style="padding-top: 48px;">
      <div class="search-row">
        <input type="text" id="subject-input" placeholder="Paste a Bluesky post URL" />
        <button id="search-btn" class="btn-primary">Search</button>
      </div>
    </div>

    <!-- Notes (shown after search) -->
    <div id="notes-section" class="hidden">
      <div class="divider"></div>
      <div class="notes-header">
        <span class="notes-title">Notes</span>
        <span class="note-count" id="note-count"></span>
      </div>
      <div id="notes-list"></div>
      <div id="empty-notes" class="empty-state hidden">
        No notes yet. Be the first to add context.
      </div>
    </div>

    <!-- Create Note (shown after search, if logged in) -->
    <div id="create-note-section" class="create-section hidden">
      <div class="divider"></div>
      <div style="padding-top: 48px;">
        <div class="section-title">Add a note</div>
        <p class="create-hint">
          Notes get certified when people with <em>diverse perspectives</em> agree they are helpful.
        </p>
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
      var isCallback = window.location.search.indexOf('code=') !== -1 || window.location.search.indexOf('state=') !== -1 || window.location.hash.indexOf('code=') !== -1 || window.location.hash.indexOf('state=') !== -1;
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
        responseMode: 'query',
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
      // Check both query string and hash for auth params (auth server may use either)
      const hasSearchParams = window.location.search.includes('code=') || window.location.search.includes('state=');
      const hasHashParams = window.location.hash.includes('code=') || window.location.hash.includes('state=');

      // If params ended up in hash, move them to query string so BrowserOAuthClient can find them
      if (!hasSearchParams && hasHashParams) {
        console.log('[chorus] Auth params in hash fragment, moving to query string...');
        const hashParams = new URLSearchParams(window.location.hash.substring(1));
        const url = new URL(window.location.href);
        hashParams.forEach(function(v, k) { url.searchParams.set(k, v); });
        url.hash = '';
        window.history.replaceState({}, '', url.toString());
      }

      const isCallback = hasSearchParams || hasHashParams;
      console.log('[chorus] initOAuth start, isCallback:', isCallback, 'pathname:', window.location.pathname, 'search:', window.location.search.substring(0, 120), 'hash:', window.location.hash.substring(0, 80));
      console.log('[chorus] redirect_uri:', REDIRECT_URI);

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

        console.log('[chorus] init result:', result ? (result.session ? 'got session' : 'result but no session') : 'no session/undefined');

        if (result?.session) {
          session = result.session;
          if (isCallback) {
            window.history.replaceState({}, '', '/');
          }
          showLoggedIn();
        } else {
          if (isCallback) {
            // Callback detected but no session — likely stale PKCE state from before a redirect_uri change.
            // Clear storage and show login so user can try again cleanly.
            console.warn('[chorus] Callback detected but init returned no session. Clearing stale state.');
            await clearAtprotoStorage();
            window.history.replaceState({}, '', '/');
          }
          showLoggedOut();
        }
      } catch (e) {
        console.error('[chorus] OAuth init error:', e);

        if (isCallback) {
          // Callback failed — likely stale PKCE state from redirect_uri change.
          // Clean up and show login form for fresh attempt.
          console.log('[chorus] Callback failed, clearing stale state for fresh login...');
          await clearAtprotoStorage();
          window.history.replaceState({}, '', '/');
          showLoggedOut();
          showMessage('Session expired — please sign in again.', 'error');
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
