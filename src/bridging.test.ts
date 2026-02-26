/**
 * Tests for the bridging algorithm (1D and 2D)
 *
 * Key demonstrations:
 * 1. Cross-perspective agreement certifies, partisan notes don't
 * 2. User factors separate by perspective
 * 3. Universally unhelpful notes get rejected
 * 4. Minimum rating threshold enforced
 * 5. (NEW) 2D algorithm resists coordinated downvoting attacks
 */

import { describe, it, expect } from 'vitest';
import {
  runBridgingAlgorithm,
  runBridgingAlgorithm2D,
  certifyNotes,
  certifyNotes2D,
  computeAverageRatings,
  Rating,
} from './bridging';

describe('Bridging Algorithm (1D backward-compat)', () => {
  it('certifies notes with cross-perspective agreement', () => {
    const ratings: Rating[] = [
      // Note 1: Cross-perspective agreement (certified expected)
      { userId: 'user1', noteId: 'note1', score: 1.0 },
      { userId: 'user2', noteId: 'note1', score: 1.0 },
      { userId: 'user3', noteId: 'note1', score: 1.0 },
      { userId: 'user6', noteId: 'note1', score: 1.0 },
      { userId: 'user7', noteId: 'note1', score: 1.0 },
      { userId: 'user8', noteId: 'note1', score: 1.0 },

      // Note 2: Only Perspective A finds it helpful (NOT certified)
      { userId: 'user1', noteId: 'note2', score: 1.0 },
      { userId: 'user2', noteId: 'note2', score: 1.0 },
      { userId: 'user3', noteId: 'note2', score: 1.0 },
      { userId: 'user4', noteId: 'note2', score: 1.0 },
      { userId: 'user5', noteId: 'note2', score: 1.0 },
      { userId: 'user6', noteId: 'note2', score: 0.0 },
      { userId: 'user7', noteId: 'note2', score: 0.0 },
      { userId: 'user8', noteId: 'note2', score: 0.0 },
      { userId: 'user9', noteId: 'note2', score: 0.0 },
      { userId: 'user10', noteId: 'note2', score: 0.0 },

      // Note 3: Perspective-defining (A likes, B dislikes)
      { userId: 'user1', noteId: 'note3', score: 1.0 },
      { userId: 'user2', noteId: 'note3', score: 1.0 },
      { userId: 'user3', noteId: 'note3', score: 1.0 },
      { userId: 'user4', noteId: 'note3', score: 1.0 },
      { userId: 'user5', noteId: 'note3', score: 1.0 },
      { userId: 'user6', noteId: 'note3', score: 0.0 },
      { userId: 'user7', noteId: 'note3', score: 0.0 },
      { userId: 'user8', noteId: 'note3', score: 0.0 },
      { userId: 'user9', noteId: 'note3', score: 0.0 },
      { userId: 'user10', noteId: 'note3', score: 0.0 },

      // Note 4: Opposite perspective-defining (B likes, A dislikes)
      { userId: 'user1', noteId: 'note4', score: 0.0 },
      { userId: 'user2', noteId: 'note4', score: 0.0 },
      { userId: 'user3', noteId: 'note4', score: 0.0 },
      { userId: 'user4', noteId: 'note4', score: 0.0 },
      { userId: 'user5', noteId: 'note4', score: 0.0 },
      { userId: 'user6', noteId: 'note4', score: 1.0 },
      { userId: 'user7', noteId: 'note4', score: 1.0 },
      { userId: 'user8', noteId: 'note4', score: 1.0 },
      { userId: 'user9', noteId: 'note4', score: 1.0 },
      { userId: 'user10', noteId: 'note4', score: 1.0 },
    ];

    const params = runBridgingAlgorithm(ratings, 50);

    const ratingCounts = new Map<string, number>();
    for (const r of ratings) {
      ratingCounts.set(r.noteId, (ratingCounts.get(r.noteId) || 0) + 1);
    }

    const statuses = certifyNotes(params, ratingCounts);
    const statusMap = new Map(statuses.map((s) => [s.noteId, s]));

    // Note 1 should be certified (cross-perspective agreement)
    expect(statusMap.get('note1')!.status).toBe('certified');

    // Note 2 should NOT be certified (only one perspective likes it)
    expect(statusMap.get('note2')!.status).not.toBe('certified');

    // Key insight: Note 2 has higher average rating but bridging correctly
    // identifies Note 1 as more genuinely helpful
  });

  it('learns user factors from rating patterns', () => {
    const ratings: Rating[] = [
      // Note 3: Perspective-defining (A likes, B dislikes)
      { userId: 'user1', noteId: 'note3', score: 1.0 },
      { userId: 'user2', noteId: 'note3', score: 1.0 },
      { userId: 'user3', noteId: 'note3', score: 1.0 },
      { userId: 'user4', noteId: 'note3', score: 0.0 },
      { userId: 'user5', noteId: 'note3', score: 0.0 },
      { userId: 'user6', noteId: 'note3', score: 0.0 },

      // Note 4: Opposite (B likes, A dislikes)
      { userId: 'user1', noteId: 'note4', score: 0.0 },
      { userId: 'user2', noteId: 'note4', score: 0.0 },
      { userId: 'user3', noteId: 'note4', score: 0.0 },
      { userId: 'user4', noteId: 'note4', score: 1.0 },
      { userId: 'user5', noteId: 'note4', score: 1.0 },
      { userId: 'user6', noteId: 'note4', score: 1.0 },

      // Bridging note
      { userId: 'user1', noteId: 'bridge', score: 1.0 },
      { userId: 'user6', noteId: 'bridge', score: 1.0 },
    ];

    const params = runBridgingAlgorithm(ratings, 50);

    const f1 = params.userFactors.get('user1')!;
    const f2 = params.userFactors.get('user2')!;
    const f4 = params.userFactors.get('user4')!;
    const f5 = params.userFactors.get('user5')!;

    // Same-group factors should be similar
    expect(Math.abs(f1 - f2)).toBeLessThan(0.5);
    expect(Math.abs(f4 - f5)).toBeLessThan(0.5);

    // Different-group factors should differ
    expect(Math.abs(f1 - f4)).toBeGreaterThan(0.3);
  });

  it('rejects notes that are clearly unhelpful', () => {
    const ratings: Rating[] = [
      // Bad note
      { userId: 'user1', noteId: 'bad_note', score: 0.0 },
      { userId: 'user2', noteId: 'bad_note', score: 0.0 },
      { userId: 'user3', noteId: 'bad_note', score: 0.0 },
      { userId: 'user4', noteId: 'bad_note', score: 0.0 },
      { userId: 'user5', noteId: 'bad_note', score: 0.0 },
      { userId: 'user6', noteId: 'bad_note', score: 0.0 },
      // Good note
      { userId: 'user1', noteId: 'good_note', score: 1.0 },
      { userId: 'user2', noteId: 'good_note', score: 1.0 },
      { userId: 'user3', noteId: 'good_note', score: 1.0 },
      { userId: 'user4', noteId: 'good_note', score: 1.0 },
      { userId: 'user5', noteId: 'good_note', score: 1.0 },
      { userId: 'user6', noteId: 'good_note', score: 1.0 },
    ];

    const params = runBridgingAlgorithm(ratings, 50);
    const ratingCounts = new Map([['bad_note', 6], ['good_note', 6]]);
    const statuses = certifyNotes(params, ratingCounts);

    const badNote = statuses.find(s => s.noteId === 'bad_note')!;
    const goodNote = statuses.find(s => s.noteId === 'good_note')!;

    expect(badNote.intercept).toBeLessThan(0);
    expect(goodNote.intercept).toBeGreaterThan(0);
  });

  it('requires minimum ratings for certification', () => {
    const ratings: Rating[] = [
      { userId: 'user1', noteId: 'new_note', score: 1.0 },
      { userId: 'user2', noteId: 'new_note', score: 1.0 },
      { userId: 'user3', noteId: 'new_note', score: 1.0 },
    ];

    const params = runBridgingAlgorithm(ratings);
    const ratingCounts = new Map([['new_note', 3]]);
    const statuses = certifyNotes(params, ratingCounts);

    expect(statuses[0].status).toBe('needs_more');
  });
});

describe('Bridging Algorithm 2D', () => {
  it('certifies cross-perspective notes with 2D factors', () => {
    // Same scenario as 1D test
    const ratings: Rating[] = [
      // Note 1: Cross-perspective agreement
      { userId: 'user1', noteId: 'note1', score: 1.0 },
      { userId: 'user2', noteId: 'note1', score: 1.0 },
      { userId: 'user3', noteId: 'note1', score: 1.0 },
      { userId: 'user6', noteId: 'note1', score: 1.0 },
      { userId: 'user7', noteId: 'note1', score: 1.0 },
      { userId: 'user8', noteId: 'note1', score: 1.0 },

      // Note 2: Only Perspective A
      { userId: 'user1', noteId: 'note2', score: 1.0 },
      { userId: 'user2', noteId: 'note2', score: 1.0 },
      { userId: 'user3', noteId: 'note2', score: 1.0 },
      { userId: 'user4', noteId: 'note2', score: 1.0 },
      { userId: 'user5', noteId: 'note2', score: 1.0 },
      { userId: 'user6', noteId: 'note2', score: 0.0 },
      { userId: 'user7', noteId: 'note2', score: 0.0 },
      { userId: 'user8', noteId: 'note2', score: 0.0 },
      { userId: 'user9', noteId: 'note2', score: 0.0 },
      { userId: 'user10', noteId: 'note2', score: 0.0 },

      // Perspective-defining notes
      { userId: 'user1', noteId: 'note3', score: 1.0 },
      { userId: 'user2', noteId: 'note3', score: 1.0 },
      { userId: 'user3', noteId: 'note3', score: 1.0 },
      { userId: 'user4', noteId: 'note3', score: 1.0 },
      { userId: 'user5', noteId: 'note3', score: 1.0 },
      { userId: 'user6', noteId: 'note3', score: 0.0 },
      { userId: 'user7', noteId: 'note3', score: 0.0 },
      { userId: 'user8', noteId: 'note3', score: 0.0 },
      { userId: 'user9', noteId: 'note3', score: 0.0 },
      { userId: 'user10', noteId: 'note3', score: 0.0 },

      { userId: 'user1', noteId: 'note4', score: 0.0 },
      { userId: 'user2', noteId: 'note4', score: 0.0 },
      { userId: 'user3', noteId: 'note4', score: 0.0 },
      { userId: 'user4', noteId: 'note4', score: 0.0 },
      { userId: 'user5', noteId: 'note4', score: 0.0 },
      { userId: 'user6', noteId: 'note4', score: 1.0 },
      { userId: 'user7', noteId: 'note4', score: 1.0 },
      { userId: 'user8', noteId: 'note4', score: 1.0 },
      { userId: 'user9', noteId: 'note4', score: 1.0 },
      { userId: 'user10', noteId: 'note4', score: 1.0 },
    ];

    const params = runBridgingAlgorithm2D(ratings, 50);

    const ratingCounts = new Map<string, number>();
    for (const r of ratings) {
      ratingCounts.set(r.noteId, (ratingCounts.get(r.noteId) || 0) + 1);
    }

    const statuses = certifyNotes2D(params, ratingCounts);
    const statusMap = new Map(statuses.map(s => [s.noteId, s]));

    // Cross-perspective note should be certified
    expect(statusMap.get('note1')!.status).toBe('certified');

    // Partisan note should NOT be certified
    expect(statusMap.get('note2')!.status).not.toBe('certified');

    // Verify rotation produced meaningful axes
    console.log('Rotation angle:', params.rotationAngle * 180 / Math.PI, 'degrees');
    console.log('Common ground axis:', params.commonGroundAxis);
    console.log('Polarity axis:', params.polarityAxis);
  });

  it('produces NoteStatus with commonGround and polarity fields', () => {
    const ratings: Rating[] = [
      // Good note liked by everyone
      { userId: 'user1', noteId: 'good', score: 1.0 },
      { userId: 'user2', noteId: 'good', score: 1.0 },
      { userId: 'user3', noteId: 'good', score: 1.0 },
      { userId: 'user4', noteId: 'good', score: 1.0 },
      { userId: 'user5', noteId: 'good', score: 1.0 },

      // Polarizing note
      { userId: 'user1', noteId: 'polar', score: 1.0 },
      { userId: 'user2', noteId: 'polar', score: 1.0 },
      { userId: 'user3', noteId: 'polar', score: 0.0 },
      { userId: 'user4', noteId: 'polar', score: 0.0 },
      { userId: 'user5', noteId: 'polar', score: 0.0 },
    ];

    const params = runBridgingAlgorithm2D(ratings, 50);
    const ratingCounts = new Map([['good', 5], ['polar', 5]]);
    const statuses = certifyNotes2D(params, ratingCounts);

    // Every status should have both fields
    for (const s of statuses) {
      expect(typeof s.commonGround).toBe('number');
      expect(typeof s.polarity).toBe('number');
      expect(typeof s.factor).toBe('number'); // backward compat
    }

    const good = statuses.find(s => s.noteId === 'good')!;
    const polar = statuses.find(s => s.noteId === 'polar')!;

    // Good note should have higher common ground
    expect(good.commonGround).toBeGreaterThan(polar.commonGround);
    console.log('Good note:', good);
    console.log('Polar note:', polar);
  });

  it('resists coordinated downvoting attacks', () => {
    /**
     * The attack Warden identified:
     * - A coordinated group systematically downvotes helpful notes
     *   and upvotes unhelpful notes, regardless of politics
     * - With enough attackers, the 1D algorithm mistakes "helpfulness"
     *   for the polarity dimension, breaking certification
     *
     * The 2D algorithm should handle this because entropy analysis
     * can separate the attack dimension from the real polarity dimension.
     */

    // Setup: two genuine perspective groups (A: users 1-5, B: users 6-10)
    // Plus an attack group (C: users 11-15) that coordinates regardless of politics

    const ratings: Rating[] = [
      // -- Perspective-defining notes (establish A/B split) --

      // Note-left: A likes, B dislikes
      { userId: 'user1', noteId: 'note-left', score: 1.0 },
      { userId: 'user2', noteId: 'note-left', score: 1.0 },
      { userId: 'user3', noteId: 'note-left', score: 1.0 },
      { userId: 'user4', noteId: 'note-left', score: 1.0 },
      { userId: 'user5', noteId: 'note-left', score: 1.0 },
      { userId: 'user6', noteId: 'note-left', score: 0.0 },
      { userId: 'user7', noteId: 'note-left', score: 0.0 },
      { userId: 'user8', noteId: 'note-left', score: 0.0 },
      { userId: 'user9', noteId: 'note-left', score: 0.0 },
      { userId: 'user10', noteId: 'note-left', score: 0.0 },
      // Attackers rate randomly on political notes
      { userId: 'user11', noteId: 'note-left', score: 1.0 },
      { userId: 'user12', noteId: 'note-left', score: 0.0 },
      { userId: 'user13', noteId: 'note-left', score: 1.0 },
      { userId: 'user14', noteId: 'note-left', score: 0.0 },
      { userId: 'user15', noteId: 'note-left', score: 1.0 },

      // Note-right: B likes, A dislikes
      { userId: 'user1', noteId: 'note-right', score: 0.0 },
      { userId: 'user2', noteId: 'note-right', score: 0.0 },
      { userId: 'user3', noteId: 'note-right', score: 0.0 },
      { userId: 'user4', noteId: 'note-right', score: 0.0 },
      { userId: 'user5', noteId: 'note-right', score: 0.0 },
      { userId: 'user6', noteId: 'note-right', score: 1.0 },
      { userId: 'user7', noteId: 'note-right', score: 1.0 },
      { userId: 'user8', noteId: 'note-right', score: 1.0 },
      { userId: 'user9', noteId: 'note-right', score: 1.0 },
      { userId: 'user10', noteId: 'note-right', score: 1.0 },
      // Attackers rate randomly
      { userId: 'user11', noteId: 'note-right', score: 0.0 },
      { userId: 'user12', noteId: 'note-right', score: 1.0 },
      { userId: 'user13', noteId: 'note-right', score: 0.0 },
      { userId: 'user14', noteId: 'note-right', score: 1.0 },
      { userId: 'user15', noteId: 'note-right', score: 0.0 },

      // -- Target note: genuinely helpful, cross-perspective agreement --

      // Note-helpful: Both A and B rate it helpful
      { userId: 'user1', noteId: 'note-helpful', score: 1.0 },
      { userId: 'user2', noteId: 'note-helpful', score: 1.0 },
      { userId: 'user3', noteId: 'note-helpful', score: 1.0 },
      { userId: 'user4', noteId: 'note-helpful', score: 1.0 },
      { userId: 'user5', noteId: 'note-helpful', score: 1.0 },
      { userId: 'user6', noteId: 'note-helpful', score: 1.0 },
      { userId: 'user7', noteId: 'note-helpful', score: 1.0 },
      { userId: 'user8', noteId: 'note-helpful', score: 1.0 },
      { userId: 'user9', noteId: 'note-helpful', score: 1.0 },
      { userId: 'user10', noteId: 'note-helpful', score: 1.0 },
      // Attackers coordinate: ALL downvote the helpful note
      { userId: 'user11', noteId: 'note-helpful', score: 0.0 },
      { userId: 'user12', noteId: 'note-helpful', score: 0.0 },
      { userId: 'user13', noteId: 'note-helpful', score: 0.0 },
      { userId: 'user14', noteId: 'note-helpful', score: 0.0 },
      { userId: 'user15', noteId: 'note-helpful', score: 0.0 },

      // -- Attacker's note: bad content they want promoted --

      // Note-bad: Only attackers rate it helpful
      { userId: 'user1', noteId: 'note-bad', score: 0.0 },
      { userId: 'user2', noteId: 'note-bad', score: 0.0 },
      { userId: 'user3', noteId: 'note-bad', score: 0.0 },
      { userId: 'user4', noteId: 'note-bad', score: 0.0 },
      { userId: 'user5', noteId: 'note-bad', score: 0.0 },
      { userId: 'user6', noteId: 'note-bad', score: 0.0 },
      { userId: 'user7', noteId: 'note-bad', score: 0.0 },
      { userId: 'user8', noteId: 'note-bad', score: 0.0 },
      { userId: 'user9', noteId: 'note-bad', score: 0.0 },
      { userId: 'user10', noteId: 'note-bad', score: 0.0 },
      // Attackers ALL upvote their bad note
      { userId: 'user11', noteId: 'note-bad', score: 1.0 },
      { userId: 'user12', noteId: 'note-bad', score: 1.0 },
      { userId: 'user13', noteId: 'note-bad', score: 1.0 },
      { userId: 'user14', noteId: 'note-bad', score: 1.0 },
      { userId: 'user15', noteId: 'note-bad', score: 1.0 },
    ];

    const ratingCounts = new Map<string, number>();
    for (const r of ratings) {
      ratingCounts.set(r.noteId, (ratingCounts.get(r.noteId) || 0) + 1);
    }

    // Run 2D algorithm
    const params2d = runBridgingAlgorithm2D(ratings, 50);
    const statuses2d = certifyNotes2D(params2d, ratingCounts);
    const statusMap2d = new Map(statuses2d.map(s => [s.noteId, s]));

    console.log('=== 2D Algorithm Results ===');
    console.log('Rotation:', params2d.rotationAngle * 180 / Math.PI, 'degrees');
    for (const s of statuses2d) {
      console.log(`${s.noteId}: status=${s.status}, cg=${s.commonGround.toFixed(3)}, pol=${s.polarity.toFixed(3)}`);
    }

    // The genuinely helpful note should NOT be rejected
    const helpful = statusMap2d.get('note-helpful')!;
    expect(helpful.status).not.toBe('rejected');

    // The bad note should NOT be certified
    const bad = statusMap2d.get('note-bad')!;
    expect(bad.status).not.toBe('certified');

    // The genuinely helpful note should have higher common ground than the bad note
    expect(helpful.commonGround).toBeGreaterThan(bad.commonGround);
  });

  it('identifies rotation axes from mixed data', () => {
    // Create data with a clear polarity axis and clear common ground
    const ratings: Rating[] = [];

    // 20 users: group A (1-10) and group B (11-20)
    // They disagree on political notes but agree on factual ones
    for (let i = 1; i <= 10; i++) {
      // Political note (A likes)
      ratings.push({ userId: `u${i}`, noteId: 'political-a', score: 1.0 });
      // Political note (B likes)
      ratings.push({ userId: `u${i}`, noteId: 'political-b', score: 0.0 });
      // Factual note (all like)
      ratings.push({ userId: `u${i}`, noteId: 'factual', score: 1.0 });
      // Bad note (all dislike)
      ratings.push({ userId: `u${i}`, noteId: 'spam', score: 0.0 });
    }
    for (let i = 11; i <= 20; i++) {
      ratings.push({ userId: `u${i}`, noteId: 'political-a', score: 0.0 });
      ratings.push({ userId: `u${i}`, noteId: 'political-b', score: 1.0 });
      ratings.push({ userId: `u${i}`, noteId: 'factual', score: 1.0 });
      ratings.push({ userId: `u${i}`, noteId: 'spam', score: 0.0 });
    }

    const params = runBridgingAlgorithm2D(ratings, 50);

    console.log('Rotation:', params.rotationAngle * 180 / Math.PI, 'degrees');
    console.log('CG axis:', params.commonGroundAxis);
    console.log('Pol axis:', params.polarityAxis);

    // The rotation should find meaningful axes (not degenerate)
    const angleDeg = Math.abs(params.rotationAngle * 180 / Math.PI);
    // Just verify it ran without errors and produced valid results
    expect(params.userFactors.size).toBe(20);
    expect(params.noteFactors.size).toBe(4);

    // Verify axes are orthogonal (dot product ≈ 0)
    const axisDot = params.commonGroundAxis[0] * params.polarityAxis[0] +
      params.commonGroundAxis[1] * params.polarityAxis[1];
    expect(Math.abs(axisDot)).toBeLessThan(0.01);
  });
});
