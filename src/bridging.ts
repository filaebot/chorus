/**
 * Bridging-Based Ranking Algorithm
 *
 * Implements the Community Notes algorithm using Alternating Least Squares (ALS).
 * The key insight: notes are only certified when they receive positive ratings
 * from raters with diverse perspectives (different factor values).
 *
 * Model: rating_ij ≈ μ + i_u + i_n + f_u * f_n
 *
 * Where:
 * - μ: global mean rating
 * - i_u: user intercept (rating bias)
 * - i_n: note intercept (intrinsic helpfulness)
 * - f_u: user factor (perspective/ideology, 1D)
 * - f_n: note factor (perspective alignment, 1D)
 *
 * A note is certified when:
 * - i_n > 0.4 (genuinely helpful across perspectives)
 * - |f_n| < 0.5 (not too aligned with any single perspective)
 */

export interface Rating {
  userId: string;
  noteId: string;
  score: number; // 0, 0.5, or 1
}

export interface BridgingParams {
  mu: number;
  userIntercepts: Map<string, number>;
  noteIntercepts: Map<string, number>;
  userFactors: Map<string, number>;
  noteFactors: Map<string, number>;
}

export interface NoteStatus {
  noteId: string;
  intercept: number;
  factor: number;
  ratingCount: number;
  avgRating: number;
  status: 'certified' | 'needs_more' | 'rejected' | 'pending';
}

// Regularization weights (from Community Notes)
const LAMBDA_INTERCEPT = 0.15;
const LAMBDA_FACTOR = 0.03;

// Certification thresholds
// Community Notes uses 0.4 for intercept; we use 0.35 for POC
// with smaller datasets. Tune based on real data.
const INTERCEPT_THRESHOLD = 0.35;
const FACTOR_THRESHOLD = 0.5;
const REJECTION_THRESHOLD = -0.15;
const MIN_RATINGS = 5;

/**
 * Group ratings by a key function
 */
function groupBy<T>(items: T[], keyFn: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = keyFn(item);
    const group = groups.get(key) || [];
    group.push(item);
    groups.set(key, group);
  }
  return groups;
}

/**
 * Solve for user parameters given fixed note parameters.
 * Solves the 2x2 linear system: (A^T A + λI) x = A^T b
 */
function solveUserParams(
  userRatings: Rating[],
  mu: number,
  noteIntercepts: Map<string, number>,
  noteFactors: Map<string, number>,
): { intercept: number; factor: number } {
  // Build the normal equations for [i_u, f_u]
  let A11 = LAMBDA_INTERCEPT;
  let A12 = 0;
  let A22 = LAMBDA_FACTOR;
  let b1 = 0;
  let b2 = 0;

  for (const r of userRatings) {
    const i_n = noteIntercepts.get(r.noteId) || 0;
    const f_n = noteFactors.get(r.noteId) || 0;
    const residual = r.score - mu - i_n;

    A11 += 1;
    A12 += f_n;
    A22 += f_n * f_n;
    b1 += residual;
    b2 += residual * f_n;
  }

  // Solve 2x2 system using Cramer's rule
  const det = A11 * A22 - A12 * A12;
  if (Math.abs(det) < 1e-10) {
    return { intercept: 0, factor: 0 };
  }

  return {
    intercept: (A22 * b1 - A12 * b2) / det,
    factor: (A11 * b2 - A12 * b1) / det,
  };
}

/**
 * Solve for note parameters given fixed user parameters.
 * Same structure as solveUserParams, swapping user/note roles.
 */
function solveNoteParams(
  noteRatings: Rating[],
  mu: number,
  userIntercepts: Map<string, number>,
  userFactors: Map<string, number>,
): { intercept: number; factor: number } {
  let A11 = LAMBDA_INTERCEPT;
  let A12 = 0;
  let A22 = LAMBDA_FACTOR;
  let b1 = 0;
  let b2 = 0;

  for (const r of noteRatings) {
    const i_u = userIntercepts.get(r.userId) || 0;
    const f_u = userFactors.get(r.userId) || 0;
    const residual = r.score - mu - i_u;

    A11 += 1;
    A12 += f_u;
    A22 += f_u * f_u;
    b1 += residual;
    b2 += residual * f_u;
  }

  const det = A11 * A22 - A12 * A12;
  if (Math.abs(det) < 1e-10) {
    return { intercept: 0, factor: 0 };
  }

  return {
    intercept: (A22 * b1 - A12 * b2) / det,
    factor: (A11 * b2 - A12 * b1) / det,
  };
}

/**
 * Compute reconstruction loss for a set of ratings
 */
function computeLoss(
  ratings: Rating[],
  params: BridgingParams,
): number {
  let totalLoss = 0;

  for (const r of ratings) {
    const i_u = params.userIntercepts.get(r.userId) || 0;
    const i_n = params.noteIntercepts.get(r.noteId) || 0;
    const f_u = params.userFactors.get(r.userId) || 0;
    const f_n = params.noteFactors.get(r.noteId) || 0;

    const predicted = params.mu + i_u + i_n + f_u * f_n;
    const error = r.score - predicted;
    totalLoss += error * error;
  }

  // Add regularization terms
  for (const i_u of params.userIntercepts.values()) {
    totalLoss += LAMBDA_INTERCEPT * i_u * i_u;
  }
  for (const i_n of params.noteIntercepts.values()) {
    totalLoss += LAMBDA_INTERCEPT * i_n * i_n;
  }
  for (const f_u of params.userFactors.values()) {
    totalLoss += LAMBDA_FACTOR * f_u * f_u;
  }
  for (const f_n of params.noteFactors.values()) {
    totalLoss += LAMBDA_FACTOR * f_n * f_n;
  }

  return totalLoss;
}

/**
 * Simple deterministic hash for seeding
 */
function hashString(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32bit integer
  }
  return hash;
}

/**
 * Run the bridging algorithm using Alternating Least Squares.
 *
 * @param ratings Array of all ratings
 * @param iterations Number of ALS iterations (default 20)
 * @returns Learned parameters for all users and notes
 */
export function runBridgingAlgorithm(
  ratings: Rating[],
  iterations: number = 20,
): BridgingParams {
  if (ratings.length === 0) {
    return {
      mu: 0.5,
      userIntercepts: new Map(),
      noteIntercepts: new Map(),
      userFactors: new Map(),
      noteFactors: new Map(),
    };
  }

  // Compute global mean
  const mu = ratings.reduce((s, r) => s + r.score, 0) / ratings.length;

  // Initialize parameters
  const userIntercepts = new Map<string, number>();
  const noteIntercepts = new Map<string, number>();
  const userFactors = new Map<string, number>();
  const noteFactors = new Map<string, number>();

  // Group ratings for initial factor estimation
  const ratingsByUser = groupBy(ratings, (r) => r.userId);
  const ratingsByNote = groupBy(ratings, (r) => r.noteId);

  // Get unique users and notes
  const userIds = new Set(ratings.map((r) => r.userId));
  const noteIds = new Set(ratings.map((r) => r.noteId));

  // Initialize intercepts to 0, factors with small deterministic values
  // based on rating deviation from mean (breaks symmetry)
  for (const userId of userIds) {
    userIntercepts.set(userId, 0);
    // Initialize user factor based on average deviation from global mean
    const userRatings = ratingsByUser.get(userId) || [];
    const avgDev = userRatings.reduce((s, r) => s + (r.score - mu), 0) / userRatings.length;
    userFactors.set(userId, avgDev * 0.5);
  }
  for (const noteId of noteIds) {
    noteIntercepts.set(noteId, 0);
    // Initialize note factor based on rating variance pattern
    const noteRatings = ratingsByNote.get(noteId) || [];
    const avgDev = noteRatings.reduce((s, r) => s + (r.score - mu), 0) / noteRatings.length;
    noteFactors.set(noteId, avgDev * 0.3);
  }

  // ALS iterations
  for (let iter = 0; iter < iterations; iter++) {
    // Update user parameters (holding note parameters fixed)
    for (const [userId, userRatings] of ratingsByUser) {
      const { intercept, factor } = solveUserParams(
        userRatings,
        mu,
        noteIntercepts,
        noteFactors,
      );
      userIntercepts.set(userId, intercept);
      userFactors.set(userId, factor);
    }

    // Update note parameters (holding user parameters fixed)
    for (const [noteId, noteRatings] of ratingsByNote) {
      const { intercept, factor } = solveNoteParams(
        noteRatings,
        mu,
        userIntercepts,
        userFactors,
      );
      noteIntercepts.set(noteId, intercept);
      noteFactors.set(noteId, factor);
    }
  }

  return { mu, userIntercepts, noteIntercepts, userFactors, noteFactors };
}

/**
 * Determine certification status for each note based on learned parameters.
 */
export function certifyNotes(
  params: BridgingParams,
  ratingCounts: Map<string, number>,
): NoteStatus[] {
  const results: NoteStatus[] = [];

  for (const [noteId, intercept] of params.noteIntercepts) {
    const factor = params.noteFactors.get(noteId) || 0;
    const ratingCount = ratingCounts.get(noteId) || 0;

    let status: NoteStatus['status'];

    if (ratingCount < MIN_RATINGS) {
      // Not enough ratings yet
      status = 'needs_more';
    } else if (intercept > INTERCEPT_THRESHOLD && Math.abs(factor) < FACTOR_THRESHOLD) {
      // Certified: high helpfulness + cross-perspective agreement
      status = 'certified';
    } else if (intercept < REJECTION_THRESHOLD) {
      // Rejected: clearly unhelpful
      status = 'rejected';
    } else {
      // Pending: has ratings but doesn't meet threshold
      status = 'pending';
    }

    results.push({
      noteId,
      intercept,
      factor,
      ratingCount,
      avgRating: 0, // Will be computed separately
      status,
    });
  }

  return results;
}

/**
 * Compute simple average ratings for comparison.
 */
export function computeAverageRatings(ratings: Rating[]): Map<string, number> {
  const sums = new Map<string, number>();
  const counts = new Map<string, number>();

  for (const r of ratings) {
    sums.set(r.noteId, (sums.get(r.noteId) || 0) + r.score);
    counts.set(r.noteId, (counts.get(r.noteId) || 0) + 1);
  }

  const avgs = new Map<string, number>();
  for (const [noteId, sum] of sums) {
    avgs.set(noteId, sum / (counts.get(noteId) || 1));
  }

  return avgs;
}
