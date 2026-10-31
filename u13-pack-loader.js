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
  // iPhone (2026-10-31, "stuck at 98"): a phone connection can go silent mid-part and a stalled read never ends, so
  // every wait has a limit; a part that stalls is fetched again from its start (STALL_MS without a byte = stalled).
  var STALL_MS = 20000, TRIES = 5;
  function within(p, ms, what) {
    return new Promise(function (ok, no) {
      var t = setTimeout(function () { no(new Error(what + ' stalled')); }, ms);
      p.then(function (v) { clearTimeout(t); ok(v); }, function (e) { clearTimeout(t); no(e); });
    });
  }

  function getPart(i, tries) {
    return within(origFetch(P.parts[i], { cache: tries ? 'reload' : 'default' }), STALL_MS * 2, 'part ' + i).then(function (r) {
      if (!r.ok) throw new Error('part ' + i + ' HTTP ' + r.status);
      return r;
    }).catch(function (e) {
      if ((tries || 0) >= TRIES) throw e;
      return new Promise(function (ok) { setTimeout(ok, 1500 * ((tries || 0) + 1)); }).then(function () { return getPart(i, (tries || 0) + 1); });
    });
  }

  // iPhone (2026-10-31, "start match it restarts"): holding the whole ~860 MB pack in the page left no room for a fight
  // and Safari reloaded the tab. Phones now read the pack LAZILY: nothing is downloaded up front, the file system asks for
  // bytes and each ~4 MB part is fetched (synchronously, the engine's file reads are synchronous) when first needed, with
  // only the last KEEP parts held in memory. Desktop keeps the FULL download (one buffer, parts fetched 4 at a time).
  // ?pack=lazy|full forces either. split_pack.mjs patches index.js so GodotFS.copy_to_fs builds the lazy file.
  var PB = P.part || 95e6, N = P.parts.length;
  function partLen(i) { return Math.min(P.size, (i + 1) * PB) - i * PB; }
  var q = (location.search.match(/[?&]pack=(lazy|full)\b/) || [])[1];
  var phone = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  window.U13_PACK_MODE = q || (phone ? 'lazy' : 'full');

  function fullLoad(tracker) {
    var buf;
    try { buf = new Uint8Array(P.size); }
    catch (e) { return Promise.reject(new Error('Not enough memory on this device for the game (' + Math.round(P.size / 1e6) + ' MB).')); }
    var total = 0, next = 0, live = 0, done = 0, failed = false;
    if (tracker) { tracker.total = P.size; tracker.loaded = 0; }
    function one(i, tries) {
      var off = i * PB, got = 0;
      return getPart(i, tries).then(function (r) {
        var reader = r.body.getReader();
        function pump() {
          return within(reader.read(), STALL_MS, 'part ' + i).then(function (res) {
            if (res.done) return;
            if (got + res.value.length > partLen(i)) throw new Error('part ' + i + ' larger than expected');
            buf.set(res.value, off + got);
            got += res.value.length; total += res.value.length;
            if (tracker) tracker.loaded = total;
            return pump();
          });
        }
        return pump().then(function () {
          if (got !== partLen(i)) throw new Error('part ' + i + ' incomplete');
        }).catch(function (e) {
          try { reader.cancel(); } catch (x) {}
          throw e;
        });
      }).catch(function (e) {
        // a dropped or stalled part: that part again from its start
        total -= got;
        if (tracker) tracker.loaded = total;
        if ((tries || 0) >= TRIES) throw e;
        return one(i, (tries || 0) + 1);
      });
    }
    return new Promise(function (ok, no) {
      function kick() {
        while (live < 4 && next < N) {
          live++;
          one(next++, 0).then(function () {
            live--; done++;
            if (done === N) { if (tracker) tracker.done = true; ok(buf.buffer); }
            else kick();
          }, function (e) { if (!failed) { failed = true; no(e); } });
        }
      }
      kick();
    });
  }

  function lazyLoad(tracker) {
    var KEEP = 24, cache = {}, order = [], pending = {};
    function keep(i, u) {
      if (!cache[i]) { order.push(i); while (order.length > KEEP) delete cache[order.shift()]; }
      cache[i] = u;
    }
    function syncGet(i) {
      var want = partLen(i);
      for (var t = 0; ; t++) {
        try {
          var x = new XMLHttpRequest();
          x.open('GET', P.parts[i], false);
          x.overrideMimeType('text/plain; charset=x-user-defined');   // raw bytes from a synchronous request
          x.send(null);
          if (x.status !== 200) throw new Error('part ' + i + ' HTTP ' + x.status);
          var s = x.responseText;
          if (s.length !== want) throw new Error('part ' + i + ' is ' + s.length + ' bytes, not ' + want);
          var u = new Uint8Array(want);
          for (var k = 0; k < want; k++) u[k] = s.charCodeAt(k) & 255;
          return u;
        } catch (e) {
          if (t >= TRIES) throw e;
        }
      }
    }
    // the parts after the one just read are fetched in the background (reads mostly run forward through a file).
    // 2026-10-31 (PC froze for good after START with ?pack=lazy): a background fetch made from the page is only read
    // by the page, and the page is blocked inside the synchronous request, so the unread response filled the shared
    // HTTP/2 connection and the synchronous request behind it never arrived. A Worker reads its responses on its own
    // thread, so the background fetches run there; without a Worker there is no read-ahead.
    var helper = null;
    try {
      helper = new Worker(URL.createObjectURL(new Blob(['onmessage=function(e){var d=e.data;fetch(d.url).then(function(r){return r.arrayBuffer()}).then(function(b){postMessage({i:d.i,b:b},[b])},function(){postMessage({i:d.i})})}'], { type: 'text/javascript' })));
      helper.onmessage = function (e) {
        var i = e.data.i, b = e.data.b;
        delete pending[i];
        if (b && b.byteLength === partLen(i) && !cache[i]) keep(i, new Uint8Array(b));
      };
    } catch (e) { helper = null; }
    function warm(i) {
      if (!helper || i >= N || cache[i] || pending[i]) return;
      pending[i] = 1;
      helper.postMessage({ i: i, url: new URL(P.parts[i], location.href).href });
    }
    function chunk(i) {
      var u = cache[i];
      if (u) {
        var k = order.indexOf(i);
        if (k >= 0) { order.splice(k, 1); order.push(i); }
        return u;
      }
      u = syncGet(i);
      keep(i, u);
      warm(i + 1); warm(i + 2);
      return u;
    }
    function read(dst, len, pos) {
      for (var d = 0; d < len;) {
        var i = Math.floor((pos + d) / PB), u = chunk(i), o = pos + d - i * PB, n = Math.min(len - d, u.length - o);
        dst.set(u.subarray(o, o + n), d);
        d += n;
      }
    }
    if (tracker) { tracker.total = P.size; tracker.loaded = P.size; tracker.done = true; }
    return Promise.resolve({ u13Lazy: function (FS, path) {
      var idx = path.lastIndexOf('/'), dir = idx > 0 ? path.slice(0, idx) : '/';
      try { FS.stat(dir); } catch (e) { FS.mkdirTree(dir); }
      FS.writeFile(path, new Uint8Array(0));
      var node = FS.lookupPath(path).node, ops = {};
      node.usedBytes = P.size;   // the size MEMFS reports (stat, seek to end)
      for (var key in node.stream_ops) ops[key] = node.stream_ops[key];
      ops.read = function (stream, buffer, offset, length, position) {
        if (position >= P.size) return 0;
        var n = Math.min(length, P.size - position);
        read(new Uint8Array(buffer.buffer, buffer.byteOffset + offset, n), n, position);
        return n;
      };
      ops.write = function () { throw new FS.ErrnoError(29); };
      node.stream_ops = ops;
    } });
  }

  window.U13_PACK_LOAD = function (tracker) {
    return window.U13_PACK_MODE === 'lazy' ? lazyLoad(tracker) : fullLoad(tracker);
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
