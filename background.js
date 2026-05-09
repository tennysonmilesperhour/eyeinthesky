// Geck Inspect — background service worker v4.1
// Zero extra network requests — all data from page's own fetch calls

importScripts('config.js');

const KEYS = {
  CAPTURES:   'gi_captures',
  PRICES:     'gi_prices',
  SELLERS:    'gi_sellers',
  ALERTS:     'gi_alerts',
  HITS:       'gi_hits',
  SHOWS:      'gi_shows',
  LAST_SEEN:  'gi_last_seen',   // listing key → last seen date (for sold inference)
  LISTINGS:   'gi_listings',    // lightweight listing cache (key → first_listed, price, title)
  SOLD_INF:   'gi_sold_inf',    // inferred sold listings
  SYNC_STATS: 'gi_sync_stats',  // ingest health: { lastSuccessAt, lastErrorAt, lastErrorStatus, lastErrorDetail, successes24h[] }
};

// ── API sender ────────────────────────────────────────────────────────────────
async function sendToAPI(type, key, data, captured_at) {
  let ok = false;
  let status = 0;
  let errBody = '';
  try {
    const res = await fetch(CONFIG.INGEST_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': CONFIG.API_KEY },
      body: JSON.stringify({
        events: [{ type, payload: { key, data, captured_at } }]
      })
    });
    status = res.status;
    ok = res.ok;
    if (!ok) {
      try { errBody = (await res.text()).slice(0, 200); } catch {}
    }
  } catch (e) {
    errBody = (e && e.message) ? String(e.message).slice(0, 200) : 'network error';
  }
  // Record the outcome. Never let a logging failure poison the caller.
  recordSyncResult(ok, status, errBody).catch(() => {});
  return ok;
}

// Canonical-shape sender for events that don't need legacyAdapter translation.
// Used for the listingImage path (CAPTURE_IMAGE) so the server's
// handleListingImage runs directly instead of going through the legacy
// gallery -> listingImage adapter.
async function sendCanonicalEvent(type, payload, occurred_at) {
  let ok = false;
  let status = 0;
  let errBody = '';
  try {
    const res = await fetch(CONFIG.INGEST_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': CONFIG.API_KEY },
      body: JSON.stringify({
        events: [{ type, payload, occurred_at, source: 'extension' }]
      })
    });
    status = res.status;
    ok = res.ok;
    if (!ok) {
      try { errBody = (await res.text()).slice(0, 200); } catch {}
    }
  } catch (e) {
    errBody = (e && e.message) ? String(e.message).slice(0, 200) : 'network error';
  }
  recordSyncResult(ok, status, errBody).catch(() => {});
  return ok;
}

// Keep a rolling record of POST outcomes so the popup can show "Sync: Live · 12s ago".
// Successes are stored as a capped array of epoch-ms timestamps so we can count "/ 24h"
// without unbounded growth. The most recent failure (if more recent than the most
// recent success) is surfaced verbatim so silent 4xx errors become visible.
async function recordSyncResult(ok, status, errBody) {
  const s = await chrome.storage.local.get(KEYS.SYNC_STATS);
  const stats = s[KEYS.SYNC_STATS] || { successes24h: [] };
  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  const cutoff = now - 24 * 60 * 60 * 1000;
  stats.successes24h = (stats.successes24h || []).filter(t => t >= cutoff);
  if (ok) {
    stats.successes24h.push(now);
    stats.lastSuccessAt = nowIso;
  } else {
    stats.lastErrorAt = nowIso;
    stats.lastErrorStatus = status;
    stats.lastErrorDetail = errBody || '';
  }
  await chrome.storage.local.set({ [KEYS.SYNC_STATS]: stats });
}

// ── Show keywords ─────────────────────────────────────────────────────────────
const SHOW_KEYWORDS = ['NARBC','Repticon','NRBE','FROG','Tinley','Hamburg',
  'White Plains','Daytona','expo','HERPS','Great Lakes','Midwest'];

function extractShows(text, key) {
  if (!text) return [];
  return SHOW_KEYWORDS
    .filter(kw => text.toUpperCase().includes(kw.toUpperCase()))
    .map(show => ({ show, listing_key: key }));
}

// ── Price drop detection ──────────────────────────────────────────────────────
async function checkPriceDrop(key, newPrice, title, captured_at) {
  if (!newPrice || newPrice > CONFIG.SUSPICIOUS_PRICE) return;
  const s = await chrome.storage.local.get(KEYS.PRICES);
  const prices = s[KEYS.PRICES] || {};
  const history = prices[key] || [];
  const last = history[history.length - 1];

  if (last && last.price > newPrice) {
    const drop = last.price - newPrice;
    const dropPct = Math.round((drop / last.price) * 100);
    await sendToAPI('price_drop', key, {
      key, title, previous_price: last.price, new_price: newPrice,
      drop_amount: drop, drop_pct: dropPct,
      previous_date: last.date, drop_date: captured_at
    }, captured_at);
    await addHit({ type: 'price_drop', key, title, drop, dropPct, date: captured_at });
    console.log(`[GeckInspect] Price drop: ${key} $${last.price}→$${newPrice} (-${dropPct}%)`);
  }

  history.push({ price: newPrice, date: captured_at });
  if (history.length > 50) history.splice(0, history.length - 50);
  prices[key] = history;
  await chrome.storage.local.set({ [KEYS.PRICES]: prices });
}

// ── Competitor alerts ─────────────────────────────────────────────────────────
async function checkAlerts(listing) {
  const s = await chrome.storage.local.get(KEYS.ALERTS);
  const alerts = s[KEYS.ALERTS] || [];
  if (!alerts.length) return;

  const title = (listing.title || listing.clean_title || '').toLowerCase();
  const traits = (listing.norm_traits || '').toLowerCase();
  const sex = (listing.sex || '').toLowerCase();
  const maturity = (listing.maturity || '').toLowerCase();
  const price = listing.price || listing.usd_price || 0;
  const key = String(listing.key || listing.id);

  for (const alert of alerts) {
    let match = true;
    if (alert.keyword && !title.includes(alert.keyword.toLowerCase()) &&
        !traits.includes(alert.keyword.toLowerCase())) match = false;
    if (alert.max_price && price > alert.max_price) match = false;
    if (alert.min_price && price < alert.min_price) match = false;
    if (alert.sex && alert.sex !== 'any' && sex !== alert.sex) match = false;
    if (alert.maturity && alert.maturity !== 'any' && maturity !== alert.maturity) match = false;
    if (match) {
      await addHit({
        type: 'alert_match', listing_key: key, alert_name: alert.name,
        title: listing.title, price, sex: listing.sex, maturity: listing.maturity,
        url: listing.path || listing.share_url, date: new Date().toISOString()
      });
    }
  }
}

// ── Seller momentum ───────────────────────────────────────────────────────────
async function trackSeller(id, name, key, firstListed) {
  if (!id) return;
  const s = await chrome.storage.local.get(KEYS.SELLERS);
  const sellers = s[KEYS.SELLERS] || {};
  if (!sellers[id]) sellers[id] = { name, seen_keys: [], listings: [] };
  const seller = sellers[id];
  if (!seller.seen_keys.includes(key)) {
    seller.seen_keys.push(key);
    seller.listings.push({ key, first_listed: firstListed, seen_at: new Date().toISOString() });
    if (seller.listings.length > 500) seller.listings.splice(0, seller.listings.length - 500);
  }
  await chrome.storage.local.set({ [KEYS.SELLERS]: sellers });
}

// ── Last seen / sold inference ────────────────────────────────────────────────
async function updateLastSeen(key, firstListed, price, title) {
  const s = await chrome.storage.local.get(KEYS.LAST_SEEN);
  const ls = s[KEYS.LAST_SEEN] || {};
  ls[key] = { date: new Date().toISOString(), first_listed: firstListed, price, title };
  await chrome.storage.local.set({ [KEYS.LAST_SEEN]: ls });
}

// Store lightweight listing cache for age badge lookups
async function cacheListingMeta(key, firstListed, price, title) {
  const s = await chrome.storage.local.get(KEYS.LISTINGS);
  const listings = s[KEYS.LISTINGS] || {};
  if (!listings[key]) {
    listings[key] = { first_listed: firstListed, price, title };
    await chrome.storage.local.set({ [KEYS.LISTINGS]: listings });
  }
}

// Run periodically to infer sold listings
// A listing not seen in 14+ days that was active is likely sold
async function inferSoldListings() {
  const s = await chrome.storage.local.get([KEYS.LAST_SEEN, KEYS.SOLD_INF]);
  const ls = s[KEYS.LAST_SEEN] || {};
  const sold = s[KEYS.SOLD_INF] || {};
  const cutoff = Date.now() - (14 * 24 * 60 * 60 * 1000); // 14 days

  let newInferences = 0;
  for (const [key, entry] of Object.entries(ls)) {
    if (sold[key]) continue; // already inferred
    const lastSeen = new Date(entry.date).getTime();
    if (lastSeen < cutoff) {
      sold[key] = {
        key,
        title: entry.title,
        price: entry.price,
        first_listed: entry.first_listed,
        last_seen: entry.date,
        inferred_sold_date: entry.date, // best estimate
        days_listed: entry.first_listed
          ? Math.floor((new Date(entry.date) - new Date(entry.first_listed)) / 86400000)
          : null,
        inferred_at: new Date().toISOString()
      };
      // Send to API as inferred sold event
      await sendToAPI('inferred_sold', key, sold[key], new Date().toISOString());
      newInferences++;
    }
  }

  if (newInferences > 0) {
    await chrome.storage.local.set({ [KEYS.SOLD_INF]: sold });
    console.log(`[GeckInspect] Inferred ${newInferences} new sold listings`);
  }
}

// ── Auction outcome tracking ──────────────────────────────────────────────────
async function checkAuctionOutcome(auctionId, data, captured_at) {
  // If auction has ended and has a winner, it's a real sale
  const endTime = data.end_time ? new Date(data.end_time) : null;
  const isEnded = endTime && endTime < new Date();
  const hasBids = data.bid_count > 0;
  const finalPrice = data.highest_bid;

  if (isEnded && hasBids && finalPrice) {
    await sendToAPI('auction_outcome', String(auctionId), {
      auction_id: auctionId,
      listing_key: data.animal,
      final_price: finalPrice,
      bid_count: data.bid_count,
      end_time: data.end_time,
      captured_at
    }, captured_at);
    console.log(`[GeckInspect] Auction outcome: ${auctionId} sold for $${finalPrice}`);
  }
}

// ── Hit storage ───────────────────────────────────────────────────────────────
async function addHit(hit) {
  const s = await chrome.storage.local.get(KEYS.HITS);
  const hits = s[KEYS.HITS] || [];
  if (hit.type === 'alert_match') {
    if (hits.find(h => h.listing_key === hit.listing_key && h.alert_name === hit.alert_name)) return;
  }
  hits.unshift(hit);
  if (hits.length > 500) hits.splice(500);
  await chrome.storage.local.set({ [KEYS.HITS]: hits });
}

// ── Handle page data ──────────────────────────────────────────────────────────
async function handlePageData(dataType, url, data, captured_at) {
  try {
    if (dataType === 'animal') {
      const key = String(data.id);
      await sendToAPI('animal', key, data, captured_at);
      await checkPriceDrop(key, data.price, data.clean_title, captured_at);
      await checkAlerts(data);
      await updateLastSeen(key, data.first_listed, data.price, data.clean_title);
      await cacheListingMeta(key, data.first_listed, data.price, data.clean_title);

      const shows = extractShows(data.desc, key);
      if (shows.length) {
        const ss = await chrome.storage.local.get(KEYS.SHOWS);
        const all = ss[KEYS.SHOWS] || [];
        shows.forEach(sh => all.push(sh));
        await chrome.storage.local.set({ [KEYS.SHOWS]: all });
        await sendToAPI('show_mentions', key, { key, shows }, captured_at);
      }

      if (data.owner) await trackSeller(data.owner.id, data.owner.clean_name, key, data.first_listed);

      if (data.dams?.length || data.sires?.length) {
        await sendToAPI('lineage', key, {
          key,
          dams: (data.dams||[]).map(d=>({id:d.id,title:d.clean_title,cached_traits:d.cached_traits})),
          sires: (data.sires||[]).map(s=>({id:s.id,title:s.clean_title,cached_traits:s.cached_traits}))
        }, captured_at);
      }

      // Emit a gallery event for ANY image count. Single-image listings used
      // to be skipped here, which meant they never produced a listingImage
      // row server-side. The server's legacyAdapter for `animal` events now
      // also fans out per-image listingImage events directly, so this is
      // belt-and-suspenders; the unique constraint on (listing_id,image_url)
      // collapses duplicates.
      if (data.images?.length) {
        await sendToAPI('gallery', key, {
          key, images: data.images.map(i=>({url:i.image,caption:i.caption}))
        }, captured_at);
      }

      // Check auction outcome if this listing has an auction
      if (data.auction?.id) {
        await checkAuctionOutcome(data.auction.id, data.auction, captured_at);
      }

      console.log('[GeckInspect] Animal:', key, data.clean_title);

    } else if (dataType === 'listings') {
      const isSold = url.includes('state=sold');
      const traitM = url.match(/trait=([^&]+)/);
      const storeM = url.match(/store=([^&]+)/);
      const pageParam = url.match(/[?&]page=(\d+)/);
      const page = pageParam ? parseInt(pageParam[1]) : 1;
      let type = 'listings_page';
      if (isSold) type = 'sold_listings';
      else if (traitM) type = 'trait_listings';
      else if (storeM) type = 'store_listings';

      await sendToAPI(type, `${type}_p${page}`, { ...data, _source_url: url }, captured_at);

      for (const r of (data.results || [])) {
        const key = String(r.key);
        await checkPriceDrop(key, r.price, r.title, captured_at);
        await checkAlerts(r);
        await updateLastSeen(key, r.first_listed, r.price, r.title);
        await cacheListingMeta(key, r.first_listed, r.price, r.title);
        if (r.store_name) await trackSeller(r.store_name, r.store_name, key, r.first_listed);

        // Check auction outcomes on search results
        if (r.auction?.id && r.auction.end_time && new Date(r.auction.end_time) < new Date()) {
          await checkAuctionOutcome(r.auction.id, r.auction, captured_at);
        }
      }

      // Run sold inference periodically (on every 5th page load)
      if (page % 5 === 0) await inferSoldListings();

      console.log('[GeckInspect]', type, 'p'+page, data.results?.length, 'items');

    } else if (dataType === 'seller') {
      const id = data.id || url.match(/stores\/([^/?]+)\//)?.[1];
      if (id) await sendToAPI('seller_profile', id, data, captured_at);

    } else if (dataType === 'auction') {
      const id = data.id || url.match(/auctions\/(\d+)\//)?.[1];
      if (id) {
        await sendToAPI('auction', String(id), data, captured_at);
        await checkAuctionOutcome(id, data, captured_at);
      }
    }
  } catch (err) {
    console.warn('[GeckInspect] handlePageData error:', err.message);
  }
}

// ── Message handler ───────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {

  if (msg.type === 'CHECK_CAPTURED') {
    chrome.storage.local.get(KEYS.LAST_SEEN).then(s => {
      const ls = s[KEYS.LAST_SEEN] || {};
      sendResponse(!!ls[msg.key]);
    });
    return true;
  }

  if (msg.type === 'PAGE_DATA') {
    handlePageData(msg.dataType, msg.url, msg.data, msg.captured_at)
      .then(() => sendResponse({ ok: true }));
    return true;
  }

  if (msg.type === 'RECORD_LAST_SEEN') {
    // Content script reporting a listing page was visited
    chrome.storage.local.get(KEYS.LAST_SEEN).then(s => {
      const ls = s[KEYS.LAST_SEEN] || {};
      if (ls[msg.key]) {
        ls[msg.key].date = msg.seen_at;
        ls[msg.key].url = msg.url;
      } else {
        ls[msg.key] = { date: msg.seen_at, url: msg.url };
      }
      chrome.storage.local.set({ [KEYS.LAST_SEEN]: ls });
    });
    return false;
  }

  if (msg.type === 'GET_LISTING_DATE') {
    chrome.storage.local.get(KEYS.LISTINGS).then(s => {
      const listings = s[KEYS.LISTINGS] || {};
      sendResponse(listings[msg.key] || null);
    });
    return true;
  }

  if (msg.type === 'CAPTURE_IMAGE') {
    (async () => {
      const s = await chrome.storage.local.get(KEYS.CAPTURES);
      const captures = s[KEYS.CAPTURES] || {};
      const isDuplicate = !!captures[msg.key];
      if (!isDuplicate) {
        captures[msg.key] = { ...msg.metadata, image_url: msg.imageUrl };
        await chrome.storage.local.set({ [KEYS.CAPTURES]: captures });
      }

      // Emit a canonical listingImage event so the server can fetch and
      // store the bytes in Supabase. Previously this handler only kicked
      // off a chrome.downloads.download to the user's local disk, which
      // meant the image never reached geck-data and morph ID training had
      // nothing to consume. Always emit (even on duplicate) so a fresh
      // ingest after a server outage still gets a chance to store the row.
      sendCanonicalEvent(
        'listingImage',
        {
          listing_id: String(msg.key),
          image_url: msg.imageUrl,
          caption: msg.metadata?.caption,
        },
        new Date().toISOString(),
      ).catch(() => {});

      if (isDuplicate) {
        return sendResponse({ ok: true, duplicate: true });
      }

      try {
        await chrome.downloads.download({
          url: msg.imageUrl,
          filename: `geck_inspect/images/${msg.key}.jpg`,
          conflictAction: 'overwrite', saveAs: false
        });
        sendResponse({ ok: true });
      } catch(e) { sendResponse({ ok: false, error: e.message }); }
    })();
    return true;
  }

  if (msg.type === 'CROSS_PLATFORM_LISTING') {
    sendToAPI('cross_platform', msg.key, msg.data, new Date().toISOString())
      .then(ok => sendResponse({ ok }));
    return true;
  }

  if (msg.type === 'GET_STATS') {
    (async () => {
      const [c, p, sel, h, sh, ls, si] = await Promise.all([
        chrome.storage.local.get(KEYS.CAPTURES),
        chrome.storage.local.get(KEYS.PRICES),
        chrome.storage.local.get(KEYS.SELLERS),
        chrome.storage.local.get(KEYS.HITS),
        chrome.storage.local.get(KEYS.SHOWS),
        chrome.storage.local.get(KEYS.LAST_SEEN),
        chrome.storage.local.get(KEYS.SOLD_INF),
      ]);
      const hits = h[KEYS.HITS] || [];
      sendResponse({
        images: Object.keys(c[KEYS.CAPTURES]||{}).length,
        price_histories: Object.keys(p[KEYS.PRICES]||{}).length,
        sellers_tracked: Object.keys(sel[KEYS.SELLERS]||{}).length,
        price_drops: hits.filter(h=>h.type==='price_drop').length,
        alert_matches: hits.filter(h=>h.type==='alert_match').length,
        show_mentions: (sh[KEYS.SHOWS]||[]).length,
        listings_tracked: Object.keys(ls[KEYS.LAST_SEEN]||{}).length,
        inferred_sold: Object.keys(si[KEYS.SOLD_INF]||{}).length,
      });
    })();
    return true;
  }

  if (msg.type === 'GET_ALERTS') {
    chrome.storage.local.get(KEYS.ALERTS).then(s => sendResponse(s[KEYS.ALERTS]||[]));
    return true;
  }
  if (msg.type === 'SAVE_ALERTS') {
    chrome.storage.local.set({ [KEYS.ALERTS]: msg.alerts }).then(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg.type === 'GET_ALERT_HITS') {
    chrome.storage.local.get(KEYS.HITS).then(s => sendResponse(s[KEYS.HITS]||[]));
    return true;
  }
  if (msg.type === 'GET_PRICE_DROPS') {
    chrome.storage.local.get(KEYS.HITS).then(s => {
      sendResponse((s[KEYS.HITS]||[]).filter(h=>h.type==='price_drop').slice(0,50));
    });
    return true;
  }
  if (msg.type === 'GET_INFERRED_SOLD') {
    chrome.storage.local.get(KEYS.SOLD_INF).then(s => {
      sendResponse(Object.values(s[KEYS.SOLD_INF]||{}).slice(0,50));
    });
    return true;
  }
  if (msg.type === 'GET_SHOWS') {
    chrome.storage.local.get(KEYS.SHOWS).then(s => sendResponse(s[KEYS.SHOWS]||[]));
    return true;
  }
  if (msg.type === 'CLEAR_HITS') {
    chrome.storage.local.set({ [KEYS.HITS]: [] }).then(() => sendResponse({ ok: true }));
    return true;
  }

  if (msg.type === 'GET_SYNC_STATS') {
    chrome.storage.local.get(KEYS.SYNC_STATS).then(s => {
      const stats = s[KEYS.SYNC_STATS] || { successes24h: [] };
      sendResponse({
        lastSuccessAt:   stats.lastSuccessAt   || null,
        lastErrorAt:     stats.lastErrorAt     || null,
        lastErrorStatus: stats.lastErrorStatus || null,
        lastErrorDetail: stats.lastErrorDetail || null,
        count24h:        (stats.successes24h || []).length,
      });
    });
    return true;
  }
});
