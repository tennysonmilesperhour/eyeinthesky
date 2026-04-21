// interceptor.js — runs in MAIN world at document_start
// Uses postMessage to bridge data to the isolated content script world

(function() {
  if (window.__geckInspectInjected) return;
  window.__geckInspectInjected = true;

  const _fetch = window.fetch;

  window.fetch = async function() {
    const url = typeof arguments[0] === 'string'
      ? arguments[0]
      : (arguments[0] && arguments[0].url) || '';

    const response = await _fetch.apply(this, arguments);

    const isAnimal   = /\/api\/v1\/(?:animals|listings)\/\d+\//.test(url);
    const isListings = /\/api\/v1\/listings\/\?/.test(url) && url.includes('categ');
    const isSeller   = /\/api\/v1\/stores\/[^/?]+\//.test(url);
    const isAuction  = /\/api\/v1\/auctions\/\d+\//.test(url);

    if (isAnimal || isListings || isSeller || isAuction) {
      response.clone().json().then(function(data) {
        // postMessage crosses the MAIN ↔ ISOLATED world boundary
        window.postMessage({
          __geckInspect: true,
          url: url,
          data: data,
          type: isAnimal   ? 'animal'   :
                isListings ? 'listings' :
                isSeller   ? 'seller'   : 'auction'
        }, '*');
      }).catch(function() {});
    }

    return response;
  };

  console.log('[GeckInspect] interceptor ready');
})();
