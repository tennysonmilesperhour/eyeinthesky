// content_morphmarket.js v4.1
// - Injects fetch interceptor
// - Captures images on listing pages
// - Annotates search results with listing age badges
// - Highlights competitor alert matches
// - Tracks "last seen" for sold date inference

(function() {
  'use strict';

  // interceptor.js runs as a separate MAIN world content script
  // No injection needed here — fetch is already wrapped when this runs

  const path = window.location.pathname;
  const listingMatch = path.match(/\/crested-geckos\/(\d+)/);
  const isSearchPage = path.includes('/crested-geckos') && !listingMatch;

  // ── SPA navigation watcher ─────────────────────────────────────────────────
  // MorphMarket uses React Router — URL changes without page reload.
  // We watch for URL changes and re-run capture logic on each new listing.
  let lastUrl = window.location.href;
  const capturedKeys = new Set();

  new MutationObserver(() => {
    const currentUrl = window.location.href;
    if (currentUrl !== lastUrl) {
      lastUrl = currentUrl;
      const newMatch = currentUrl.match(/\/crested-geckos\/(\d+)/);
      if (newMatch && !capturedKeys.has(newMatch[1])) {
        setTimeout(() => captureListingPage(newMatch[1]), 1500);
      }
    }
  }).observe(document.documentElement, { childList: true, subtree: true });

  // ── Listen for intercepted API data via postMessage ────────────────────────
  window.addEventListener('message', (event) => {
    if (!event.data || !event.data.__geckInspect) return;
    const { url, data, type } = event.data;
    chrome.runtime.sendMessage({
      type: 'PAGE_DATA',
      dataType: type,
      url,
      data,
      captured_at: new Date().toISOString()
    });
  });

  // ── Individual listing page ─────────────────────────────────────────────────
  function captureListingPage(key) {
    if (capturedKeys.has(key)) return;
    capturedKeys.add(key);

    chrome.runtime.sendMessage({
      type: 'RECORD_LAST_SEEN',
      key,
      url: window.location.href,
      seen_at: new Date().toISOString()
    });

    function findBestImage() {
      const imgs = Array.from(document.querySelectorAll('img'));
      const cdn = imgs.filter(img =>
        img.src.includes('cloudfront') &&
        img.naturalWidth > 150 && img.naturalHeight > 150 &&
        !img.src.includes('230x230') && !img.src.includes('flag')
      );
      return cdn.sort((a,b) => (b.naturalWidth*b.naturalHeight)-(a.naturalWidth*a.naturalHeight))[0];
    }

    let attempts = 0;
    function tryCapture() {
      if (attempts > 30) return;
      attempts++;
      const img = findBestImage();
      if (img) {
        chrome.runtime.sendMessage({
          type: 'CAPTURE_IMAGE', key,
          imageUrl: img.src,
          metadata: { key, url: window.location.href, captured_at: new Date().toISOString() }
        }, () => showBadge('captured'));
      } else {
        setTimeout(tryCapture, 500);
      }
    }
    tryCapture();

    // Fallback fetch if interceptor missed the initial load
    setTimeout(() => {
      chrome.runtime.sendMessage({ type: 'CHECK_CAPTURED', key }, (alreadyCaptured) => {
        if (!alreadyCaptured) {
          const apiUrl = `/api/v1/listings/${key}/?order_initiator=buyer`;
          fetch(apiUrl, { credentials: 'include' })
            .then(r => r.json())
            .then(data => {
              chrome.runtime.sendMessage({
                type: 'PAGE_DATA', dataType: 'animal',
                url: apiUrl, data,
                captured_at: new Date().toISOString()
              });
              console.log('[GeckInspect] Fallback captured:', key);
            })
            .catch(() => {});
        }
      });
    }, 2000);
  }

  // Run on initial page load if we're on a listing
  if (listingMatch) {
    captureListingPage(listingMatch[1]);
  }

  // ── Search results page ─────────────────────────────────────────────────────
  if (isSearchPage) {
    // Wait for cards to render then annotate
    setTimeout(annotateSearchResults, 2000);

    // Re-annotate if user scrolls to load more
    let annotateTimer;
    window.addEventListener('scroll', () => {
      clearTimeout(annotateTimer);
      annotateTimer = setTimeout(annotateSearchResults, 800);
    });
  }

  function annotateSearchResults() {
    const links = document.querySelectorAll('a[href*="/crested-geckos/"]');
    const now = Date.now();

    // Get alert hits for highlighting
    chrome.runtime.sendMessage({ type: 'GET_ALERT_HITS' }, (hits) => {
      const alertKeys = new Set(
        (hits||[]).filter(h => h.type==='alert_match').map(h => String(h.listing_key))
      );

      links.forEach(link => {
        const keyMatch = link.href.match(/crested-geckos\/(\d+)/);
        if (!keyMatch) return;
        const key = keyMatch[1];
        const card = link.closest('[class*="card"],[class*="listing"],[class*="animal"],[class*="item"]') || link;

        // Skip if already annotated
        if (card.dataset.giAnnotated) return;
        card.dataset.giAnnotated = '1';
        if (getComputedStyle(card).position === 'static') card.style.position = 'relative';

        // ── Listing age badge ──────────────────────────────────────────────
        // Try to find first_listed date from any data-* attribute or text
        const dateText = card.textContent.match(/(\d{4}-\d{2}-\d{2})/);
        if (!dateText) {
          // Request from background
          chrome.runtime.sendMessage({ type: 'GET_LISTING_DATE', key }, (result) => {
            if (result?.first_listed) {
              addAgeBadge(card, result.first_listed, now);
            }
          });
        }

        // ── Alert highlight ────────────────────────────────────────────────
        if (alertKeys.has(key)) {
          link.style.outline = '3px solid #22c55e';
          link.style.outlineOffset = '2px';
          link.style.borderRadius = '8px';
          addBadge(card, '🎯 ALERT', '#22c55e', 'top:6px;left:6px');
        }
      });
    });
  }

  function addAgeBadge(card, firstListed, now) {
    const listed = new Date(firstListed).getTime();
    const days = Math.floor((now - listed) / 86400000);
    if (days < 0 || days > 1000) return;

    // Color code by age
    let color = '#4ade80'; // fresh (< 7 days)
    if (days > 60) color = '#ef4444';       // stale
    else if (days > 21) color = '#f59e0b';  // aging
    else if (days > 7) color = '#facc15';   // week old

    addBadge(card, `${days}d`, color, 'top:6px;right:6px');
  }

  function addBadge(card, text, color, position) {
    const badge = document.createElement('div');
    badge.style.cssText = `
      position:absolute;${position};
      background:${color};color:${color === '#facc15' ? '#000' : '#fff'};
      font-size:10px;font-weight:700;padding:2px 6px;
      border-radius:4px;z-index:99;font-family:system-ui;
      letter-spacing:0.03em;pointer-events:none;
    `;
    badge.textContent = text;
    card.appendChild(badge);
  }

  // ── Shared badge ────────────────────────────────────────────────────────────
  function showBadge(state) {
    const existing = document.getElementById('gi-badge');
    if (existing) existing.remove();
    const badge = document.createElement('div');
    badge.id = 'gi-badge';
    badge.style.cssText = `
      position:fixed;bottom:20px;right:20px;
      background:${state==='captured'?'#22c55e':'#ef4444'};
      color:white;padding:8px 14px;border-radius:6px;
      font-family:system-ui;font-size:13px;font-weight:600;
      z-index:999999;box-shadow:0 2px 8px rgba(0,0,0,0.2);transition:opacity 0.3s;
    `;
    badge.textContent = state==='captured' ? '🦎 Captured' : '⚠ No image';
    document.body.appendChild(badge);
    setTimeout(() => { badge.style.opacity='0'; setTimeout(()=>badge.remove(),300); }, 2000);
  }

})();
