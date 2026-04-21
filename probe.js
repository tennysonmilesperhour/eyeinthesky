// Temporary probe script — paste this into Chrome DevTools console
// on a MorphMarket listing page to find where the data lives

(function() {
  // Check for Redux store
  const reduxStore = window.__REDUX_STORE__ || window.store || window.__store;
  if (reduxStore) {
    console.log('Redux store found:', Object.keys(reduxStore.getState()));
    return;
  }

  // Check for Next.js / React hydration data
  const nextData = window.__NEXT_DATA__;
  if (nextData) {
    console.log('Next.js data found:', JSON.stringify(nextData).substring(0, 500));
    return;
  }

  // Check for any global state variables
  const interesting = Object.keys(window).filter(k =>
    k.includes('animal') || k.includes('listing') || k.includes('gecko') ||
    k.includes('morph') || k.includes('data') || k.includes('state') ||
    k.includes('store') || k.includes('props')
  );
  console.log('Interesting globals:', interesting);

  // Check meta tags for embedded JSON
  const metas = Array.from(document.querySelectorAll('meta[name], meta[property]'));
  metas.forEach(m => console.log('Meta:', m.name || m.getAttribute('property'), '=', m.content?.substring(0, 100)));

  // Check for JSON in script tags
  const scripts = Array.from(document.querySelectorAll('script:not([src])'));
  scripts.forEach((s, i) => {
    if (s.textContent.includes('cached_traits') || s.textContent.includes('norm_traits')) {
      console.log(`Script ${i} contains trait data:`, s.textContent.substring(0, 300));
    }
  });
})();
