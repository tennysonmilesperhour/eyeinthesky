// popup.js v4.1

function toast(msg, color='#22c55e') {
  const t = document.getElementById('toast');
  t.textContent = msg; t.style.background = color;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 2500);
}

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
  fetch('https://geck-data.vercel.app/api/stats', {
    headers: { 'X-API-Key': 'geck-2026-secret' }
  }).then(r => {
    el.textContent = r.ok ? '✓ live' : '✗ '+r.status;
    el.style.color = r.ok ? '#4ade80' : '#f87171';
  }).catch(() => { el.textContent = '✗ offline'; el.style.color = '#f87171'; });
}

document.getElementById('check-api-btn').addEventListener('click', checkAPI);
document.getElementById('open-downloads-btn').addEventListener('click', () => chrome.tabs.create({ url: 'chrome://downloads' }));
document.getElementById('clear-all-btn').addEventListener('click', () => {
  if (confirm('Clear ALL local data?')) chrome.storage.local.clear(() => toast('Cleared'));
});
