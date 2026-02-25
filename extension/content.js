// Chorus - Community Notes for Bluesky
// Content script that overlays community notes on posts

const CHORUS_API = 'https://chorus.filae.site';
const CACHE_TTL = 60000; // 1 minute cache
const noteCache = new Map();

// Track processed posts to avoid duplicate work
const processedPosts = new Set();

// Observer for SPA navigation
let observer = null;

// Initialize when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}

function init() {
  console.log('[Chorus] Initializing community notes overlay');

  // Initial scan
  scanForPosts();

  // Set up mutation observer for SPA navigation
  observer = new MutationObserver((mutations) => {
    // Debounce scanning
    if (observer.scanTimeout) clearTimeout(observer.scanTimeout);
    observer.scanTimeout = setTimeout(scanForPosts, 200);
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true
  });
}

function scanForPosts() {
  // Find all post links on the page
  // Bluesky post URLs look like: /profile/handle/post/rkey
  const postLinks = document.querySelectorAll('a[href*="/post/"]');

  postLinks.forEach(link => {
    const href = link.getAttribute('href');
    if (!href) return;

    // Extract post info from URL
    const match = href.match(/\/profile\/([^/]+)\/post\/([a-z0-9]+)/);
    if (!match) return;

    const [_, handle, rkey] = match;
    const postId = `${handle}/${rkey}`;

    // Skip if already processed
    if (processedPosts.has(postId)) return;

    // Find the post container (navigate up to find the article or post wrapper)
    const postElement = findPostContainer(link);
    if (!postElement) return;

    // Mark as processed
    processedPosts.add(postId);

    // Check for notes
    checkForNotes(handle, rkey, postElement);
  });
}

function findPostContainer(link) {
  // Navigate up to find a reasonable post container
  // Look for elements that contain the full post content
  let element = link;
  let depth = 0;

  while (element && depth < 10) {
    // Check for common post container patterns
    if (element.getAttribute('data-testid') === 'postThreadItem' ||
        element.getAttribute('data-testid') === 'feedItem' ||
        element.classList.contains('css-175oi2r') && element.querySelector('[data-testid="postText"]')) {
      return element;
    }
    element = element.parentElement;
    depth++;
  }

  // Fallback: just use the immediate parent's parent
  return link.parentElement?.parentElement;
}

async function checkForNotes(handle, rkey, postElement) {
  // Build AT-URI - need to resolve handle to DID first, but for now try with handle
  // The Chorus API should accept post URLs and resolve them
  const postUrl = `https://bsky.app/profile/${handle}/post/${rkey}`;

  // Check cache first
  const cacheKey = `${handle}/${rkey}`;
  const cached = noteCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    if (cached.notes.length > 0) {
      injectNotesBadge(postElement, cached.notes);
    }
    return;
  }

  try {
    // Query Chorus API
    // First convert Bluesky URL to AT-URI format
    const atUri = await resolvePostToAtUri(handle, rkey);
    if (!atUri) return;

    const response = await fetch(`${CHORUS_API}/api/notes?subject=${encodeURIComponent(atUri)}`);
    if (!response.ok) return;

    const data = await response.json();
    const notes = data.notes || [];

    // Cache result
    noteCache.set(cacheKey, { notes, timestamp: Date.now() });

    // Inject badge if notes exist
    if (notes.length > 0) {
      injectNotesBadge(postElement, notes);
    }
  } catch (err) {
    console.error('[Chorus] Error checking for notes:', err);
  }
}

async function resolvePostToAtUri(handle, rkey) {
  try {
    // Resolve handle to DID using Bluesky API
    const response = await fetch(`https://public.api.bsky.app/xrpc/com.atproto.identity.resolveHandle?handle=${handle}`);
    if (!response.ok) return null;

    const data = await response.json();
    const did = data.did;

    // Construct AT-URI
    return `at://${did}/app.bsky.feed.post/${rkey}`;
  } catch (err) {
    console.error('[Chorus] Error resolving handle:', err);
    return null;
  }
}

function injectNotesBadge(postElement, notes) {
  // Don't inject if already has badge
  if (postElement.querySelector('.chorus-notes-badge')) return;

  // Create badge container
  const badge = document.createElement('div');
  badge.className = 'chorus-notes-badge';

  // Count by status
  const certified = notes.filter(n => n.status === 'certified').length;
  const pending = notes.filter(n => n.status === 'pending' || n.status === 'needs_more').length;

  badge.innerHTML = `
    <div class="chorus-badge-header">
      <span class="chorus-icon">📝</span>
      <span class="chorus-label">Community Notes</span>
      <span class="chorus-count">${notes.length}</span>
      ${certified > 0 ? `<span class="chorus-certified">${certified} certified</span>` : ''}
    </div>
  `;

  // Add click handler to expand notes
  badge.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleNotesPanel(badge, notes);
  });

  // Insert badge into post
  postElement.style.position = 'relative';
  postElement.appendChild(badge);
}

function toggleNotesPanel(badge, notes) {
  const existingPanel = badge.querySelector('.chorus-notes-panel');

  if (existingPanel) {
    existingPanel.remove();
    badge.classList.remove('chorus-expanded');
    return;
  }

  badge.classList.add('chorus-expanded');

  const panel = document.createElement('div');
  panel.className = 'chorus-notes-panel';

  panel.innerHTML = notes.map(note => `
    <div class="chorus-note ${note.status}">
      <div class="chorus-note-status">${getStatusIcon(note.status)} ${note.status}</div>
      <div class="chorus-note-text">${escapeHtml(note.text)}</div>
      <div class="chorus-note-meta">
        ${note.rating_count || 0} ratings
        ${note.intercept ? ` • score: ${note.intercept.toFixed(2)}` : ''}
      </div>
    </div>
  `).join('');

  badge.appendChild(panel);
}

function getStatusIcon(status) {
  switch (status) {
    case 'certified': return '✅';
    case 'pending': return '⏳';
    case 'needs_more': return '👥';
    default: return '📝';
  }
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}
