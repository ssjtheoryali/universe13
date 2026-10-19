// U13 split-pack loader for GitHub Pages (files over 100 MB can't live in git): the Godot web shell fetches `index.pck`;
// this streams it back together from window.U13_PACK.parts (written by tools/web/pages/split_pack.mjs into u13-pack.js),
// fetching the next part while the current one is read. Load u13-pack.js, then this file, BEFORE index.js.
(function () {
  var P = window.U13_PACK;
  if (!P || !P.parts || !P.parts.length) return;
  var origFetch = window.fetch.bind(window);

  function getPart(i, tries) {
    return origFetch(P.parts[i], { cache: 'default' }).then(function (r) {
      if (!r.ok) throw new Error('part ' + i + ' HTTP ' + r.status);
      return r;
    }).catch(function (e) {
      if ((tries || 0) >= 3) throw e;
      return new Promise(function (ok) { setTimeout(ok, 1500 * ((tries || 0) + 1)); }).then(function () { return getPart(i, (tries || 0) + 1); });
    });
  }

  function packResponse() {
    var i = 0, reader = null, next = getPart(0);
    var stream = new ReadableStream({
      pull: function (ctrl) {
        function step() {
          if (reader) {
            return reader.read().then(function (res) {
              if (!res.done) { ctrl.enqueue(res.value); return; }
              reader = null;
              i += 1;
              if (i >= P.parts.length) { ctrl.close(); return; }
              return step();
            });
          }
          var cur = next;
          next = i + 1 < P.parts.length ? getPart(i + 1) : null;   // prefetch the following part
          return cur.then(function (r) { reader = r.body.getReader(); return step(); });
        }
        return step().catch(function (e) { ctrl.error(e); });
      }
    });
    return new Response(stream, { status: 200, headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(P.size) } });
  }

  window.fetch = function (input, init) {
    var url = typeof input === 'string' ? input : (input && input.url) || '';
    if (/(^|\/)index\.pck(\?|#|$)/.test(url)) return Promise.resolve(packResponse());
    return origFetch(input, init);
  };
})();
