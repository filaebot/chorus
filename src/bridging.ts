/**
 * Bridging-Based Ranking Algorithm (2D Multi-Factor)
 *
 * Implements an enhanced Community Notes algorithm using 2D matrix factorization
 * with entropy-based axis rotation. Based on Jonathan Warden's multi-factor
 * research (jonathanwarden.com/multifactor-community-notes/).
 *
 * The 1D algorithm is vulnerable to coordinated attacks: a group that
 * systematically downvotes helpful notes can make helpfulness (not polarity)
 * the primary explainable factor, breaking certification.
 *
 * The 2D approach fixes this:
 * 1. Factorize ratings into 2D user/note vectors (ALS)
 * 2. Rotate the factor space using entropy analysis
 * 3. The low-entropy axis = common ground (most users agree)
 * 4. The high-entropy axis = polarity (users disagree)
 * 5. Use the common-ground projection as the helpfulness signal
 *
 * Model: rating_ij ≈ μ + i_u + i_n + f_u · f_n  (2D dot product)
 *
 * A note is certified when:
 * - commonGround projection > threshold (genuinely helpful)
 * - |polarity projection| < threshold (not too aligned with one perspective)
 * - Sufficient ratings from diverse raters
 */

export interface Rating {
  userId: string;
  noteId: string;
  score: number; // 0, 0.5, or 1
}

export type Vec2 = [number, number];

export interface BridgingParams2D {
  mu: number;
  userIntercepts: Map<string, number>;
  noteIntercepts: Map<string, number>;
  userFactors: Map<string, Vec2>;
  noteFactors: Map<string, Vec2>;
  // Rotation info (after entropy analysis)
  rotationAngle: number; // radians
  commonGroundAxis: Vec2; // unit vector
  polarityAxis: Vec2; // unit vector
}

// Legacy 1D interface for backward compatibility with worker
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
  factor: number; // polarity projection (for backward compat)
  commonGround: number; // common-ground projection
  polarity: number; // polarity projection
  ratingCount: number;
  avgRating: number;
  status: 'certified' | 'needs_more' | 'rejected' | 'pending';
}

// Regularization weights (from Community Notes)
const LAMBDA_INTERCEPT = 0.15;
const LAMBDA_FACTOR = 0.03;

// Certification thresholds
const INTERCEPT_THRESHOLD = 0.35;
const FACTOR_THRESHOLD = 0.5;
const REJECTION_THRESHOLD = -0.15;
const MIN_RATINGS = 5;

// --- Vector operations ---

function dot2(a: Vec2, b: Vec2): number {
  return a[0] * b[0] + a[1] * b[1];
}

function norm2(v: Vec2): number {
  return Math.sqrt(v[0] * v[0] + v[1] * v[1]);
}

function scale2(v: Vec2, s: number): Vec2 {
  return [v[0] * s, v[1] * s];
}

function add2(a: Vec2, b: Vec2): Vec2 {
  return [a[0] + b[0], a[1] + b[1]];
}

// --- Helpers ---

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
 * Solve 3x3 linear system Ax = b using Cramer's rule.
 * A is given as a flat 9-element array [a00,a01,a02,a10,a11,a12,a20,a21,a22].
 * Returns [x0, x1, x2].
 */
function solve3x3(A: number[], b: number[]): [number, number, number] {
  const det =
    A[0] * (A[4] * A[8] - A[5] * A[7]) -
    A[1] * (A[3] * A[8] - A[5] * A[6]) +
    A[2] * (A[3] * A[7] - A[4] * A[6]);

  if (Math.abs(det) < 1e-10) {
    return [0, 0, 0];
  }

  const x0 =
    (b[0] * (A[4] * A[8] - A[5] * A[7]) -
      A[1] * (b[1] * A[8] - A[5] * b[2]) +
      A[2] * (b[1] * A[7] - A[4] * b[2])) /
    det;

  const x1 =
    (A[0] * (b[1] * A[8] - A[5] * b[2]) -
      b[0] * (A[3] * A[8] - A[5] * A[6]) +
      A[2] * (A[3] * b[2] - b[1] * A[6])) /
    det;

  const x2 =
    (A[0] * (A[4] * b[2] - b[1] * A[7]) -
      A[1] * (A[3] * b[2] - b[1] * A[6]) +
      b[0] * (A[3] * A[7] - A[4] * A[6])) /
    det;

  return [x0, x1, x2];
}

/**
 * Solve for user parameters given fixed note parameters (2D).
 * Solves the 3x3 system: (A^T A + λI) x = A^T b
 * for [intercept, factor0, factor1].
 */
function solveUserParams2D(
  userRatings: Rating[],
  mu: number,
  noteIntercepts: Map<string, number>,
  noteFactors: Map<string, Vec2>,
): { intercept: number; factor: Vec2 } {
  // Normal equations for [i_u, f_u0, f_u1]
  // Each rating contributes: residual = score - mu - i_n
  // prediction component from user: i_u + f_u0 * f_n0 + f_u1 * f_n1

  // A^T A + lambda I (3x3 symmetric)
  let a00 = LAMBDA_INTERCEPT; // intercept-intercept
  let a01 = 0; // intercept-factor0
  let a02 = 0; // intercept-factor1
  let a11 = LAMBDA_FACTOR; // factor0-factor0
  let a12 = 0; // factor0-factor1
  let a22 = LAMBDA_FACTOR; // factor1-factor1

  let b0 = 0;
  let b1 = 0;
  let b2 = 0;

  for (const r of userRatings) {
    const i_n = noteIntercepts.get(r.noteId) || 0;
    const f_n = noteFactors.get(r.noteId) || [0, 0] as Vec2;
    const residual = r.score - mu - i_n;

    // Design matrix row: [1, f_n0, f_n1]
    a00 += 1;
    a01 += f_n[0];
    a02 += f_n[1];
    a11 += f_n[0] * f_n[0];
    a12 += f_n[0] * f_n[1];
    a22 += f_n[1] * f_n[1];

    b0 += residual;
    b1 += residual * f_n[0];
    b2 += residual * f_n[1];
  }

  const A = [a00, a01, a02, a01, a11, a12, a02, a12, a22]; // symmetric
  const result = solve3x3(A, [b0, b1, b2]);

  return {
    intercept: result[0],
    factor: [result[1], result[2]],
  };
}

/**
 * Solve for note parameters given fixed user parameters (2D).
 */
function solveNoteParams2D(
  noteRatings: Rating[],
  mu: number,
  userIntercepts: Map<string, number>,
  userFactors: Map<string, Vec2>,
): { intercept: number; factor: Vec2 } {
  let a00 = LAMBDA_INTERCEPT;
  let a01 = 0;
  let a02 = 0;
  let a11 = LAMBDA_FACTOR;
  let a12 = 0;
  let a22 = LAMBDA_FACTOR;

  let b0 = 0;
  let b1 = 0;
  let b2 = 0;

  for (const r of noteRatings) {
    const i_u = userIntercepts.get(r.userId) || 0;
    const f_u = userFactors.get(r.userId) || [0, 0] as Vec2;
    const residual = r.score - mu - i_u;

    a00 += 1;
    a01 += f_u[0];
    a02 += f_u[1];
    a11 += f_u[0] * f_u[0];
    a12 += f_u[0] * f_u[1];
    a22 += f_u[1] * f_u[1];

    b0 += residual;
    b1 += residual * f_u[0];
    b2 += residual * f_u[1];
  }

  const A = [a00, a01, a02, a01, a11, a12, a02, a12, a22];
  const result = solve3x3(A, [b0, b1, b2]);

  return {
    intercept: result[0],
    factor: [result[1], result[2]],
  };
}

/**
 * Compute Shannon entropy of a set of values projected onto an axis.
 * Higher entropy = more disagreement along this axis.
 * Uses histogram binning.
 */
function computeAxisEntropy(factors: Vec2[], axis: Vec2): number {
  if (factors.length === 0) return 0;

  // Project all factors onto the axis
  const projections = factors.map(f => dot2(f, axis));

  // Find range
  let min = Infinity, max = -Infinity;
  for (const p of projections) {
    if (p < min) min = p;
    if (p > max) max = p;
  }

  const range = max - min;
  if (range < 1e-10) return 0;

  // Bin into 10 bins
  const nBins = 10;
  const bins = new Array(nBins).fill(0);
  for (const p of projections) {
    const bin = Math.min(Math.floor(((p - min) / range) * nBins), nBins - 1);
    bins[bin]++;
  }

  // Compute entropy
  let entropy = 0;
  const n = projections.length;
  for (const count of bins) {
    if (count > 0) {
      const p = count / n;
      entropy -= p * Math.log2(p);
    }
  }

  return entropy;
}

/**
 * Find the optimal rotation angle that maximizes entropy separation
 * between the two axes. We want one axis with maximum entropy (polarity)
 * and one with minimum entropy (common ground).
 *
 * Searches angles in [0, π) since rotation by π is equivalent.
 */
function findOptimalRotation(userFactors: Map<string, Vec2>): {
  angle: number;
  commonGroundAxis: Vec2;
  polarityAxis: Vec2;
} {
  const factors = Array.from(userFactors.values());
  if (factors.length < 3) {
    return { angle: 0, commonGroundAxis: [1, 0], polarityAxis: [0, 1] };
  }

  let bestAngle = 0;
  let bestSeparation = -Infinity;
  const steps = 36; // Search in 5-degree increments

  for (let i = 0; i < steps; i++) {
    const angle = (i * Math.PI) / steps;
    const axis1: Vec2 = [Math.cos(angle), Math.sin(angle)];
    const axis2: Vec2 = [-Math.sin(angle), Math.cos(angle)];

    const e1 = computeAxisEntropy(factors, axis1);
    const e2 = computeAxisEntropy(factors, axis2);

    // We want maximum separation: one high-entropy, one low-entropy
    const separation = Math.abs(e1 - e2);
    if (separation > bestSeparation) {
      bestSeparation = separation;
      bestAngle = angle;
    }
  }

  // Refine with finer search around best angle
  const refineRange = Math.PI / steps;
  const refineSteps = 20;
  let bestAngleRefined = bestAngle;
  let bestSepRefined = bestSeparation;

  for (let i = -refineSteps / 2; i <= refineSteps / 2; i++) {
    const angle = bestAngle + (i * refineRange) / refineSteps;
    const axis1: Vec2 = [Math.cos(angle), Math.sin(angle)];
    const axis2: Vec2 = [-Math.sin(angle), Math.cos(angle)];

    const e1 = computeAxisEntropy(factors, axis1);
    const e2 = computeAxisEntropy(factors, axis2);

    const separation = Math.abs(e1 - e2);
    if (separation > bestSepRefined) {
      bestSepRefined = separation;
      bestAngleRefined = angle;
    }
  }

  const axis1: Vec2 = [Math.cos(bestAngleRefined), Math.sin(bestAngleRefined)];
  const axis2: Vec2 = [-Math.sin(bestAngleRefined), Math.cos(bestAngleRefined)];

  const e1 = computeAxisEntropy(factors, axis1);
  const e2 = computeAxisEntropy(factors, axis2);

  // Polarity axis = higher entropy, common ground = lower entropy
  if (e1 >= e2) {
    return {
      angle: bestAngleRefined,
      polarityAxis: axis1,
      commonGroundAxis: axis2,
    };
  } else {
    return {
      angle: bestAngleRefined,
      polarityAxis: axis2,
      commonGroundAxis: axis1,
    };
  }
}

/**
 * Run the 2D bridging algorithm using Alternating Least Squares
 * with entropy-based axis rotation.
 *
 * @param ratings Array of all ratings
 * @param iterations Number of ALS iterations (default 20)
 * @returns Learned 2D parameters with rotation info
 */
export function runBridgingAlgorithm2D(
  ratings: Rating[],
  iterations: number = 20,
): BridgingParams2D {
  if (ratings.length === 0) {
    return {
      mu: 0.5,
      userIntercepts: new Map(),
      noteIntercepts: new Map(),
      userFactors: new Map(),
      noteFactors: new Map(),
      rotationAngle: 0,
      commonGroundAxis: [1, 0],
      polarityAxis: [0, 1],
    };
  }

  // Compute global mean
  const mu = ratings.reduce((s, r) => s + r.score, 0) / ratings.length;

  // Initialize parameters
  const userIntercepts = new Map<string, number>();
  const noteIntercepts = new Map<string, number>();
  const userFactors = new Map<string, Vec2>();
  const noteFactors = new Map<string, Vec2>();

  // Group ratings
  const ratingsByUser = groupBy(ratings, (r) => r.userId);
  const ratingsByNote = groupBy(ratings, (r) => r.noteId);

  const userIds = new Set(ratings.map((r) => r.userId));
  const noteIds = new Set(ratings.map((r) => r.noteId));

  // Initialize with symmetry-breaking based on rating deviation
  for (const userId of userIds) {
    userIntercepts.set(userId, 0);
    const userRatings = ratingsByUser.get(userId) || [];
    const avgDev = userRatings.reduce((s, r) => s + (r.score - mu), 0) / userRatings.length;
    // Initialize 2D factor: deviation in both dimensions with different scaling
    // to break symmetry between the two axes
    userFactors.set(userId, [avgDev * 0.5, avgDev * 0.3]);
  }
  for (const noteId of noteIds) {
    noteIntercepts.set(noteId, 0);
    const noteRatings = ratingsByNote.get(noteId) || [];
    const avgDev = noteRatings.reduce((s, r) => s + (r.score - mu), 0) / noteRatings.length;
    noteFactors.set(noteId, [avgDev * 0.3, avgDev * 0.2]);
  }

  // ALS iterations
  for (let iter = 0; iter < iterations; iter++) {
    // Update user parameters
    for (const [userId, userRatings] of ratingsByUser) {
      const { intercept, factor } = solveUserParams2D(
        userRatings, mu, noteIntercepts, noteFactors,
      );
      userIntercepts.set(userId, intercept);
      userFactors.set(userId, factor);
    }

    // Update note parameters
    for (const [noteId, noteRatings] of ratingsByNote) {
      const { intercept, factor } = solveNoteParams2D(
        noteRatings, mu, userIntercepts, userFactors,
      );
      noteIntercepts.set(noteId, intercept);
      noteFactors.set(noteId, factor);
    }
  }

  // Find optimal rotation via entropy analysis
  const { angle, commonGroundAxis, polarityAxis } = findOptimalRotation(userFactors);

  return {
    mu,
    userIntercepts,
    noteIntercepts,
    userFactors,
    noteFactors,
    rotationAngle: angle,
    commonGroundAxis,
    polarityAxis,
  };
}

/**
 * Run the bridging algorithm — backward-compatible wrapper.
 * Runs 2D internally, projects to 1D for legacy interface.
 */
export function runBridgingAlgorithm(
  ratings: Rating[],
  iterations: number = 20,
): BridgingParams {
  const params2d = runBridgingAlgorithm2D(ratings, iterations);

  // Project 2D factors onto polarity axis for legacy interface
  const userFactors1D = new Map<string, number>();
  for (const [id, f] of params2d.userFactors) {
    userFactors1D.set(id, dot2(f, params2d.polarityAxis));
  }

  const noteFactors1D = new Map<string, number>();
  for (const [id, f] of params2d.noteFactors) {
    noteFactors1D.set(id, dot2(f, params2d.polarityAxis));
  }

  return {
    mu: params2d.mu,
    userIntercepts: params2d.userIntercepts,
    noteIntercepts: params2d.noteIntercepts,
    userFactors: userFactors1D,
    noteFactors: noteFactors1D,
  };
}

/**
 * Determine certification status for each note (2D version).
 * Uses common-ground and polarity projections from the rotated factor space.
 */
export function certifyNotes2D(
  params: BridgingParams2D,
  ratingCounts: Map<string, number>,
): NoteStatus[] {
  const results: NoteStatus[] = [];

  for (const [noteId, intercept] of params.noteIntercepts) {
    const factor2d = params.noteFactors.get(noteId) || [0, 0] as Vec2;
    const ratingCount = ratingCounts.get(noteId) || 0;

    // Project note factor onto rotated axes
    const commonGround = intercept + dot2(factor2d, params.commonGroundAxis);
    const polarity = dot2(factor2d, params.polarityAxis);

    let status: NoteStatus['status'];

    if (ratingCount < MIN_RATINGS) {
      status = 'needs_more';
    } else if (commonGround > INTERCEPT_THRESHOLD && Math.abs(polarity) < FACTOR_THRESHOLD) {
      status = 'certified';
    } else if (commonGround < REJECTION_THRESHOLD) {
      status = 'rejected';
    } else {
      status = 'pending';
    }

    results.push({
      noteId,
      intercept,
      factor: polarity, // backward compat
      commonGround,
      polarity,
      ratingCount,
      avgRating: 0,
      status,
    });
  }

  return results;
}

/**
 * Legacy certification — backward-compatible wrapper.
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
      status = 'needs_more';
    } else if (intercept > INTERCEPT_THRESHOLD && Math.abs(factor) < FACTOR_THRESHOLD) {
      status = 'certified';
    } else if (intercept < REJECTION_THRESHOLD) {
      status = 'rejected';
    } else {
      status = 'pending';
    }

    results.push({
      noteId,
      intercept,
      factor,
      commonGround: intercept, // approximate in 1D mode
      polarity: factor,
      ratingCount,
      avgRating: 0,
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
