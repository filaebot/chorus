// Chorus popup - load and display stats

const CHORUS_API = 'https://chorus.filae.workers.dev';

async function loadStats() {
  const statsEl = document.getElementById('stats');

  try {
    const response = await fetch(`${CHORUS_API}/api/stats`);
    if (!response.ok) throw new Error('Failed to load stats');

    const stats = await response.json();

    statsEl.innerHTML = `
      <div class="stat-row">
        <span class="stat-label">Total Notes</span>
        <span class="stat-value">${stats.total_notes || 0}</span>
      </div>
      <div class="stat-row">
        <span class="stat-label">Certified</span>
        <span class="stat-value" style="color: #4ade80">${stats.certified_notes || 0}</span>
      </div>
      <div class="stat-row">
        <span class="stat-label">Raters</span>
        <span class="stat-value">${stats.total_raters || 0}</span>
      </div>
      <div class="stat-row">
        <span class="stat-label">Total Ratings</span>
        <span class="stat-value">${stats.total_ratings || 0}</span>
      </div>
    `;
  } catch (err) {
    console.error('[Chorus] Error loading stats:', err);
    statsEl.innerHTML = `
      <div class="stat-row">
        <span class="stat-label">Unable to load stats</span>
      </div>
    `;
  }
}

// Load stats when popup opens
loadStats();
