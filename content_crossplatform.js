// content_crossplatform.js v3.0
// Cross-platform listing capture for Fauna Classifieds, Reptile Forums, Preloved, Kijiji

(function() {
  'use strict';

  const host = window.location.hostname;
  const url = window.location.href;

  // Only process if it looks like a reptile/gecko listing
  const pageText = document.body.innerText.toLowerCase();
  const isGeckoRelated = pageText.includes('crested gecko') ||
                         pageText.includes('correlophus') ||
                         pageText.includes('crestie') ||
                         url.toLowerCase().includes('gecko');

  if (!isGeckoRelated) return;

  console.log('[GeckInspect] Cross-platform gecko content detected on:', host);

  // Extract what we can from the page
  const data = extractListing(host);
  if (!data) return;

  // Generate a stable key from URL
  const key = btoa(url).replace(/[^a-zA-Z0-9]/g, '').substring(0, 20);

  chrome.runtime.sendMessage({
    type: 'CROSS_PLATFORM_LISTING',
    key,
    data: {
      ...data,
      source_url: url,
      source_domain: host,
      captured_at: new Date().toISOString()
    }
  });

  showBadge();

  function extractListing(host) {
    const result = {
      platform: host,
      url,
      title: null,
      price: null,
      price_text: null,
      description: null,
      location: null,
      images: []
    };

    // Title — try common patterns
    const titleEl = document.querySelector('h1, h2, [class*="title"], [class*="heading"]');
    if (titleEl) result.title = titleEl.textContent.trim().substring(0, 200);

    // Price — look for currency patterns
    const pricePattern = /[\$£€¥][\s]?[\d,]+(\.\d{2})?|[\d,]+(\.\d{2})?[\s]?[\$£€]/;
    const bodyText = document.body.innerText;
    const priceMatch = bodyText.match(pricePattern);
    if (priceMatch) {
      result.price_text = priceMatch[0];
      result.price = parseFloat(priceMatch[0].replace(/[^\d.]/g, ''));
    }

    // Description
    const descEl = document.querySelector(
      '[class*="description"], [class*="body"], [class*="content"], [id*="description"]'
    );
    if (descEl) result.description = descEl.textContent.trim().substring(0, 1000);

    // Images
    const imgs = Array.from(document.querySelectorAll('img')).filter(img =>
      img.naturalWidth > 200 && img.naturalHeight > 200 &&
      !img.src.includes('logo') && !img.src.includes('avatar')
    );
    result.images = imgs.slice(0, 5).map(img => img.src);

    // Location hints
    const locationPatterns = [
      /located?\s+in\s+([A-Za-z\s,]+)/i,
      /shipping\s+from\s+([A-Za-z\s,]+)/i,
      /based\s+in\s+([A-Za-z\s,]+)/i
    ];
    for (const pattern of locationPatterns) {
      const match = bodyText.match(pattern);
      if (match) {
        result.location = match[1].trim().substring(0, 100);
        break;
      }
    }

    // Platform-specific extractors
    if (host.includes('faunaclassifieds')) {
      result.platform_name = 'Fauna Classifieds';
      const userEl = document.querySelector('[class*="username"], [class*="author"]');
      if (userEl) result.seller = userEl.textContent.trim();
    }

    if (host.includes('reptileforums')) {
      result.platform_name = 'Reptile Forums UK';
      const priceGBP = bodyText.match(/£[\s]?[\d,]+/);
      if (priceGBP) {
        result.price_text = priceGBP[0];
        result.currency = 'GBP';
      }
    }

    if (host.includes('preloved')) {
      result.platform_name = 'Preloved UK';
      result.currency = 'GBP';
    }

    if (host.includes('kijiji')) {
      result.platform_name = 'Kijiji Canada';
      result.currency = 'CAD';
      const priceEl = document.querySelector('[class*="price"]');
      if (priceEl) result.price_text = priceEl.textContent.trim();
    }

    return result;
  }

  function showBadge() {
    const badge = document.createElement('div');
    badge.style.cssText = `
      position: fixed; bottom: 20px; right: 20px;
      background: #0ea5e9; color: white;
      padding: 8px 14px; border-radius: 6px;
      font-family: system-ui; font-size: 13px; font-weight: 600;
      z-index: 999999; box-shadow: 0 2px 8px rgba(0,0,0,0.2);
      transition: opacity 0.3s;
    `;
    badge.textContent = '🦎 Cross-platform captured';
    document.body.appendChild(badge);
    setTimeout(() => {
      badge.style.opacity = '0';
      setTimeout(() => badge.remove(), 300);
    }, 2500);
  }

})();
