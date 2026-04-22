// popup.js v4.1

function toast(msg, color='#22c55e') {
  const t = document.getElementById('toast');
  t.textContent = msg; t.style.background = color;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 2500);
}

document.getElementById('version').textContent = 'v' + chrome.runtime.getManifest().version;

// ── Tab switching ─────────────────────────────────────────────────────────────
document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById('tab-' + tab.dataset.tab).classList.add('active');
    if (tab.dataset.tab === 'alerts') loadAlerts();
    if (tab.dataset.tab === 'drops') loadDrops();
    if (tab.dataset.tab === 'sold') loadSold();
    if (tab.dataset.tab === 'settings') checkAPI();
  });
});

// ── Overview ──────────────────────────────────────────────────────────────────
chrome.runtime.sendMessage({ type: 'GET_STATS' }, (stats) => {
  if (!stats) return;
  document.getElementById('s-images').textContent = stats.images || 0;
  document.getElementById('s-tracked').textContent = stats.listings_tracked || 0;
  document.getElementById('s-sellers').textContent = stats.sellers_tracked || 0;
  document.getElementById('s-drops').textContent = stats.price_drops || 0;
  document.getElementById('s-matches').textContent = stats.alert_matches || 0;
  document.getElementById('s-sold').textContent = stats.inferred_sold || 0;
});

// ── Sync status row ───────────────────────────────────────────────────────────
// Reads gi_sync_stats (written by sendToAPI in background.js) and renders an
// at-a-glance "is the ingest POSTing landing?" indicator. Polled while the
// popup is open so you can watch events land in real time.
function fmtAgo(iso) {
  if (!iso) return '—';
  const s = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return s + 's ago';
  const m = Math.floor(s / 60);
  if (m < 60) return m + 'm ago';
  const h = Math.floor(m / 60);
  if (h < 24) return h + 'h ago';
  return Math.floor(h / 24) + 'd ago';
}

function renderSync(stats) {
  const dot = document.getElementById('sync-dot');
  const txt = document.getElementById('sync-txt');
  const err = document.getElementById('sync-err');

  if (!stats || !stats.lastSuccessAt) {
    dot.classList.add('off');
    dot.style.background = '';
    dot.style.boxShadow = '';
    txt.innerHTML = 'Sync: no events sent yet';
  } else {
    const ageMin = (Date.now() - new Date(stats.lastSuccessAt).getTime()) / 60000;
    let state, color;
    if (ageMin < 15)          { state = 'live';    color = '#4ade80'; }
    else if (ageMin < 60 * 24){ state = 'lagging'; color = '#fbbf24'; }
    else                      { state = 'stale';   color = '#6b6b6b'; }
    dot.classList.remove('off');
    dot.style.background = color;
    dot.style.boxShadow = state === 'stale' ? 'none' : `0 0 5px ${color}`;
    txt.innerHTML = `<strong>Sync: ${state}</strong> — last event ${fmtAgo(stats.lastSuccessAt)} · ${stats.count24h || 0} / 24h`;
  }

  const hasFreshError = stats && stats.lastErrorAt &&
    (!stats.lastSuccessAt || new Date(stats.lastErrorAt) > new Date(stats.lastSuccessAt));
  if (hasFreshError) {
    const code = stats.lastErrorStatus || '—';
    const detail = (stats.lastErrorDetail || '').slice(0, 120);
    err.textContent = `Last error: ${code}${detail ? ' — ' + detail : ''}`;
    err.style.display = 'block';
  } else {
    err.style.display = 'none';
  }
}

function refreshSync() {
  chrome.runtime.sendMessage({ type: 'GET_SYNC_STATS' }, (stats) => {
    if (chrome.runtime.lastError) return;
    if (stats) renderSync(stats);
  });
}
refreshSync();
setInterval(refreshSync, 2000);

chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
  const tab = tabs[0];
  const dot = document.getElementById('status-dot');
  const txt = document.getElementById('status-txt');
  if (!tab?.url) return;
  if (tab.url.match(/morphmarket\.com.*crested-geckos\/\d+/)) {
    dot.classList.remove('off');
    txt.innerHTML = '<strong>Active</strong> — capturing listing';
  } else if (tab.url.includes('state=sold')) {
    dot.classList.remove('off');
    txt.innerHTML = '<strong>Active</strong> — capturing sold data 💰';
  } else if (tab.url.includes('morphmarket.com')) {
    dot.classList.remove('off');
    txt.innerHTML = 'Browsing MorphMarket';
  } else if (['faunaclassifieds','reptileforums','preloved','kijiji'].some(s => tab.url.includes(s))) {
    dot.classList.remove('off');
    txt.innerHTML = '<strong>Active</strong> — cross-platform';
  }
});

// ── Alerts ────────────────────────────────────────────────────────────────────
let savedAlerts = [];

function loadAlerts() {
  chrome.runtime.sendMessage({ type: 'GET_ALERTS' }, (alerts) => {
    savedAlerts = alerts || [];
    renderAlerts();
  });
  chrome.runtime.sendMessage({ type: 'GET_ALERT_HITS' }, (hits) => {
    const matches = (hits||[]).filter(h => h.type === 'alert_match').slice(0, 20);
    const list = document.getElementById('hits-list');
    if (!matches.length) { list.innerHTML = '<div class="empty">No matches yet</div>'; return; }
    list.innerHTML = matches.map(h => `
      <div class="list-item green">
        <div class="item-title green">${h.title || 'Listing '+h.listing_key}</div>
        <div class="item-meta green">${h.alert_name} · $${h.price||'?'} · ${h.sex||'?'} ${h.maturity||''}
          ${h.url ? `· <a href="${h.url}" target="_blank" style="color:#4ade80">view</a>` : ''}
        </div>
      </div>`).join('');
  });
}

function renderAlerts() {
  const list = document.getElementById('alert-list');
  if (!savedAlerts.length) { list.innerHTML = '<div class="empty">No alerts set</div>'; return; }
  list.innerHTML = savedAlerts.map((a, i) => `
    <div class="list-item alert-item">
      <div style="flex:1">
        <div class="item-title">${a.name}</div>
        <div class="item-meta">${[
          a.keyword && `"${a.keyword}"`,
          a.min_price && `$${a.min_price}+`,
          a.max_price && `under $${a.max_price}`,
          a.sex !== 'any' && a.sex,
          a.maturity !== 'any' && a.maturity
        ].filter(Boolean).join(' · ')}</div>
      </div>
      <button class="alert-del" data-idx="${i}">✕</button>
    </div>`).join('');

  list.querySelectorAll('.alert-del').forEach(btn => {
    btn.addEventListener('click', () => {
      savedAlerts.splice(parseInt(btn.dataset.idx), 1);
      chrome.runtime.sendMessage({ type: 'SAVE_ALERTS', alerts: savedAlerts }, () => {
        renderAlerts(); toast('Alert removed');
      });
    });
  });
}

document.getElementById('add-alert-btn').addEventListener('click', () => {
  const name = document.getElementById('alert-name').value.trim();
  if (!name) { toast('Give the alert a name', '#f59e0b'); return; }
  savedAlerts.push({
    name,
    keyword: document.getElementById('alert-keyword').value.trim(),
    min_price: parseFloat(document.getElementById('alert-min').value) || null,
    max_price: parseFloat(document.getElementById('alert-max').value) || null,
    sex: document.getElementById('alert-sex').value,
    maturity: document.getElementById('alert-maturity').value,
    created: new Date().toISOString()
  });
  chrome.runtime.sendMessage({ type: 'SAVE_ALERTS', alerts: savedAlerts }, () => {
    renderAlerts();
    ['alert-name','alert-keyword','alert-min','alert-max'].forEach(id => document.getElementById(id).value = '');
    toast('Alert saved ✓');
  });
});

// ── Price drops ───────────────────────────────────────────────────────────────
function loadDrops() {
  chrome.runtime.sendMessage({ type: 'GET_PRICE_DROPS' }, (drops) => {
    const list = document.getElementById('drops-list');
    if (!drops?.length) { list.innerHTML = '<div class="empty">No drops yet — revisit listings to detect changes</div>'; return; }
    list.innerHTML = drops.map(d => `
      <div class="list-item red">
        <div class="item-title red">↓ $${d.drop} (${d.dropPct}%) — ${d.title||'Listing '+d.key}</div>
        <div class="item-meta red">$${d.previous_price||'?'} → $${d.new_price||'?'} · ${d.date ? new Date(d.date).toLocaleDateString() : ''}</div>
      </div>`).join('');
  });
}

document.getElementById('clear-drops-btn').addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'CLEAR_HITS' }, () => { loadDrops(); toast('Cleared'); });
});

// ── Inferred sold ─────────────────────────────────────────────────────────────
function loadSold() {
  chrome.runtime.sendMessage({ type: 'GET_INFERRED_SOLD' }, (items) => {
    const list = document.getElementById('sold-list');
    if (!items?.length) { list.innerHTML = '<div class="empty">Keep browsing — sold listings infer over time</div>'; return; }
    list.innerHTML = items.map(s => `
      <div class="list-item amber">
        <div class="item-title amber">${s.title||'Listing '+s.key}</div>
        <div class="item-meta amber">
          $${s.price||'?'}
          ${s.days_listed != null ? `· ~${s.days_listed} days listed` : ''}
          · last seen ${s.last_seen ? new Date(s.last_seen).toLocaleDateString() : '?'}
        </div>
      </div>`).join('');
  });
}

// ── Settings ──────────────────────────────────────────────────────────────────
function checkAPI() {
  const el = document.getElementById('api-status');
  el.textContent = '...';
  // GET /api/ingest is a Bearer-gated diagnostic on the server that returns
  // per-table counts + most-recent timestamps. Reusing INGEST_URL + API_KEY
  // here means "the button works" always implies "POSTing from the extension
  // would also work", which is the whole point of the check.
  fetch(CONFIG.INGEST_URL, {
    method: 'GET',
    headers: { 'X-API-Key': CONFIG.API_KEY }
  }).then(r => {
    el.textContent = r.ok ? '✓ live' : '✗ ' + r.status;
    el.style.color  = r.ok ? '#4ade80' : '#f87171';
  }).catch(() => { el.textContent = '✗ offline'; el.style.color = '#f87171'; });
}

document.getElementById('check-api-btn').addEventListener('click', checkAPI);
document.getElementById('open-downloads-btn').addEventListener('click', () => chrome.tabs.create({ url: 'chrome://downloads' }));
document.getElementById('clear-all-btn').addEventListener('click', () => {
  if (confirm('Clear ALL local data?')) chrome.storage.local.clear(() => toast('Cleared'));
});
