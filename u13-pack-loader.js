// U13 split-pack loader for GitHub Pages (files over 100 MB can't live in git): the Godot web shell fetches `index.pck`;
// this streams it back together from window.U13_PACK.parts (written by tools/web/pages/split_pack.mjs into u13-pack.js),
// fetching the next part while the current one is read. Load u13-pack.js, then this file, BEFORE index.js.
// iPhone (2026-10-30, "stuck on loading"): the engine's own preload held the ~860 MB pack up to three times at once
// (the stream, its arrayBuffer() copy and the MEMFS copy) and Safari killed the tab. split_pack.mjs patches index.js so
// the pack comes from U13_PACK_LOAD below: ONE buffer of the pack's size, every part written straight into it, which the
// file system then owns (canOwn) instead of copying.
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

  // the whole pack into one preallocated buffer; tracker = the engine's progress entry ({total, loaded, done})
  window.U13_PACK_LOAD = function (tracker) {
    var buf;
    try { buf = new Uint8Array(P.size); }
    catch (e) { return Promise.reject(new Error('Not enough memory on this device for the game (' + Math.round(P.size / 1e6) + ' MB).')); }
    var off = 0, next = getPart(0);
    if (tracker) { tracker.total = P.size; tracker.loaded = 0; }
    function part(i, r, tries) {
      var start = off, reader = r.body.getReader();
      function pump() {
        return reader.read().then(function (res) {
          if (res.done) return;
          if (off + res.value.length > P.size) throw new Error('pack larger than expected');
          buf.set(res.value, off);
          off += res.value.length;
          if (tracker) tracker.loaded = off;
          return pump();
        });
      }
      return pump().catch(function (e) {
        // a dropped connection mid-part: that part again from its start
        if (tries >= 3) throw e;
        off = start;
        return getPart(i).then(function (r2) { return part(i, r2, tries + 1); });
      });
    }
    function run(i) {
      var cur = next;
      next = i + 1 < P.parts.length ? getPart(i + 1) : null;   // prefetch the following part
      return cur.then(function (r) { return part(i, r, 0); }).then(function () {
        if (i + 1 < P.parts.length) return run(i + 1);
      });
    }
    return run(0).then(function () {
      if (off !== P.size) throw new Error('pack incomplete (' + off + ' / ' + P.size + ')');
      if (tracker) tracker.done = true;
      return buf.buffer;
    });
  };

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
    // a new build must never run an old cached engine: the wasm is fetched under the build's version (split_pack --build)
    if (P.build && typeof input === 'string' && /(^|\/)index\.wasm$/.test(url)) return origFetch(url + '?v=' + encodeURIComponent(P.build), init);
    return origFetch(input, init);
  };
})();
