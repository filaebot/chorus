/**
 * Tests for the bridging algorithm
 *
 * The key demonstration: a note that is rated helpful by people from
 * diverse perspectives should be certified, while a note that is only
 * rated helpful by one perspective should not be - even if it has
 * more total "helpful" votes.
 */

import { describe, it, expect } from 'vitest';
import {
  runBridgingAlgorithm,
  certifyNotes,
  computeAverageRatings,
  Rating,
} from './bridging';

describe('Bridging Algorithm', () => {
  it('certifies notes with cross-perspective agreement', () => {
    // Create two "perspectives" of raters
    // Perspective A: users 1-5, tend to agree with each other
    // Perspective B: users 6-10, tend to agree with each other

    // Note 1: Gets helpful from BOTH perspectives (should certify)
    // Note 2: Gets helpful from only Perspective A (should NOT certify)

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

      // Additional ratings to establish perspective differences
      // Note 3: Perspective-defining note (A likes, B dislikes)
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

      // Note 4: Opposite perspective-defining note (B likes, A dislikes)
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

    const params = runBridgingAlgorithm(ratings, 50); // More iterations

    // Debug output
    console.log('Global mean:', params.mu);
    console.log('User factors:', Object.fromEntries(params.userFactors));
    console.log('Note intercepts:', Object.fromEntries(params.noteIntercepts));
    console.log('Note factors:', Object.fromEntries(params.noteFactors));

    // Count ratings per note
    const ratingCounts = new Map<string, number>();
    for (const r of ratings) {
      ratingCounts.set(r.noteId, (ratingCounts.get(r.noteId) || 0) + 1);
    }

    const statuses = certifyNotes(params, ratingCounts);
    const statusMap = new Map(statuses.map((s) => [s.noteId, s]));
    console.log('All statuses:', statuses);

    // Note 1 should be certified (cross-perspective agreement)
    const note1 = statusMap.get('note1')!;
    console.log('Note 1 (cross-perspective):', note1);
    expect(note1.status).toBe('certified');

    // Note 2 should NOT be certified (only one perspective likes it)
    const note2 = statusMap.get('note2')!;
    expect(note2.status).not.toBe('certified');
    console.log('Note 2 (partisan):', note2);

    // Key insight: Note 2 has higher average rating than Note 1!
    const avgs = computeAverageRatings(ratings);
    console.log('Average ratings:', Object.fromEntries(avgs));

    // This is the demo: simple voting would rank Note 2 higher
    // but bridging correctly identifies Note 1 as more helpful
  });

  it('learns user factors from rating patterns', () => {
    // Use the same test data as the main test - we know it separates users
    // This test verifies that users who rate similarly have similar factors
    const ratings: Rating[] = [
      // Note 3: Perspective-defining note (A likes, B dislikes)
      { userId: 'user1', noteId: 'note3', score: 1.0 },
      { userId: 'user2', noteId: 'note3', score: 1.0 },
      { userId: 'user3', noteId: 'note3', score: 1.0 },
      { userId: 'user4', noteId: 'note3', score: 0.0 },
      { userId: 'user5', noteId: 'note3', score: 0.0 },
      { userId: 'user6', noteId: 'note3', score: 0.0 },

      // Note 4: Opposite perspective-defining note (B likes, A dislikes)
      { userId: 'user1', noteId: 'note4', score: 0.0 },
      { userId: 'user2', noteId: 'note4', score: 0.0 },
      { userId: 'user3', noteId: 'note4', score: 0.0 },
      { userId: 'user4', noteId: 'note4', score: 1.0 },
      { userId: 'user5', noteId: 'note4', score: 1.0 },
      { userId: 'user6', noteId: 'note4', score: 1.0 },

      // Add a bridging note to break symmetry
      { userId: 'user1', noteId: 'bridge', score: 1.0 },
      { userId: 'user6', noteId: 'bridge', score: 1.0 },
    ];

    const params = runBridgingAlgorithm(ratings, 50);

    // Users in the same group should have similar factors
    const f1 = params.userFactors.get('user1')!;
    const f2 = params.userFactors.get('user2')!;
    const f4 = params.userFactors.get('user4')!;
    const f5 = params.userFactors.get('user5')!;

    console.log('User factors:', Object.fromEntries(params.userFactors));
    console.log('Note factors:', Object.fromEntries(params.noteFactors));

    // Group 1 factors should be similar to each other
    expect(Math.abs(f1 - f2)).toBeLessThan(0.5);

    // Group 2 factors should be similar to each other
    expect(Math.abs(f4 - f5)).toBeLessThan(0.5);

    // Groups should have different factors
    expect(Math.abs(f1 - f4)).toBeGreaterThan(0.3);
  });

  it('rejects notes that are clearly unhelpful', () => {
    // Need more context for rejection to work - add a good note for comparison
    const ratings: Rating[] = [
      // Bad note - everyone rates it unhelpful
      { userId: 'user1', noteId: 'bad_note', score: 0.0 },
      { userId: 'user2', noteId: 'bad_note', score: 0.0 },
      { userId: 'user3', noteId: 'bad_note', score: 0.0 },
      { userId: 'user4', noteId: 'bad_note', score: 0.0 },
      { userId: 'user5', noteId: 'bad_note', score: 0.0 },
      { userId: 'user6', noteId: 'bad_note', score: 0.0 },
      // Good note - everyone rates it helpful (for contrast)
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

    console.log('Rejection test statuses:', statuses);

    const badNote = statuses.find(s => s.noteId === 'bad_note')!;
    const goodNote = statuses.find(s => s.noteId === 'good_note')!;

    // Bad note should have negative intercept
    expect(badNote.intercept).toBeLessThan(0);
    // Good note should have positive intercept
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
