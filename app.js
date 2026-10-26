/* SVG to PNG — SVGs are only ever rendered through <img> from a blob: URL, never put into the page,
   so scripts, event handlers and external references inside them never run or load. */
(function () {
  "use strict";
  const $ = S3.$, $$ = S3.$$;
  const MAX_SIDE = 16384, MAX_AREA = 40e6, SVGNS = "http://www.w3.org/2000/svg";
  const saved = S3.store("svg2png") || {};
  const o = Object.assign({ mode: "scale", scale: 2, w: 1024, h: 1024, transparent: true, bg: "#ffffff" }, saved);
  let items = [], sel = null, run = 0, queue = Promise.resolve(), pasted = 0;

  // ---------- SVG handling (inert: DOMParser documents never execute anything) ----------
  const UNIT = { "": 1, px: 1, pt: 4 / 3, pc: 16, mm: 96 / 25.4, cm: 96 / 2.54, in: 96 };
  function len(v) {
    const m = /^\s*([\d.]+(?:e[-+]?\d+)?)\s*(px|pt|pc|mm|cm|in)?\s*$/i.exec(v || "");
    return m ? parseFloat(m[1]) * UNIT[(m[2] || "").toLowerCase()] : 0;
  }
  function parse(text) {
    const doc = new DOMParser().parseFromString(text, "image/svg+xml"), el = doc.documentElement;
    const err = doc.getElementsByTagName("parsererror")[0];
    if (err || !el || el.localName !== "svg") throw new Error("Not valid SVG" + (err ? ": " + (err.textContent || "").split("\n")[0].slice(0, 120) : ""));
    if (el.namespaceURI !== SVGNS) el.setAttribute("xmlns", SVGNS);
    const vb = (el.getAttribute("viewBox") || "").trim().split(/[\s,]+/).map(Number);
    const hasVb = vb.length === 4 && vb[2] > 0 && vb[3] > 0;
    let w = len(el.getAttribute("width")), h = len(el.getAttribute("height"));
    if (!w && !h && hasVb) { w = vb[2]; h = vb[3]; }
    else if (w && !h) h = hasVb ? w * vb[3] / vb[2] : w;
    else if (h && !w) w = hasVb ? h * vb[2] / vb[3] : h;
    if (!w || !h) { w = 300; h = 150; }
    if (!hasVb) el.setAttribute("viewBox", "0 0 " + w + " " + h);  // lets us scale it to any size
    return { doc, el, w, h };
  }
  function target(nw, nh, opt) {
    let w, h;
    if (opt.mode === "scale") { w = nw * opt.scale; h = nh * opt.scale; }
    else if (opt.mode === "width") { w = +opt.w || nw; h = w * nh / nw; }
    else if (opt.mode === "height") { h = +opt.h || nh; w = h * nw / nh; }
    else { w = +opt.w || nw; h = +opt.h || nh; }
    w = Math.max(1, Math.round(w)); h = Math.max(1, Math.round(h));
    if (w > MAX_SIDE || h > MAX_SIDE || w * h > MAX_AREA) throw new Error(w + "×" + h + " is too large for a browser canvas");
    return { w, h };
  }
  async function render(text, opt) {
    const p = parse(text), t = target(p.w, p.h, opt);
    // Ask the SVG itself for the output size so it is rasterised sharp, not upscaled.
    p.el.setAttribute("width", t.w); p.el.setAttribute("height", t.h);
    if (opt.mode === "exact") p.el.setAttribute("preserveAspectRatio", "none");
    const src = new Blob([new XMLSerializer().serializeToString(p.doc)], { type: "image/svg+xml" });
    const url = URL.createObjectURL(src), img = new Image();
    img.src = url;
    try { await img.decode(); } catch (e) { throw new Error("The browser could not draw this SVG"); } finally { URL.revokeObjectURL(url); }
    const c = document.createElement("canvas"); c.width = t.w; c.height = t.h;
    const x = c.getContext("2d");
    if (!opt.transparent) { x.fillStyle = opt.bg; x.fillRect(0, 0, t.w, t.h); }
    x.drawImage(img, 0, 0, t.w, t.h);
    const blob = await new Promise(r => c.toBlob(r, "image/png"));
    if (!blob) throw new Error("Could not encode the PNG");
    return { blob, w: t.w, h: t.h, nw: Math.round(p.w), nh: Math.round(p.h) };
  }
  function pngName(name, opt) {
    const base = name.replace(/\.svgz?$/i, "");
    return opt.mode === "scale" && opt.scale > 1 ? base + "@" + opt.scale + "x.png" : base + ".png";
  }

  // ---------- UI ----------
  function seg(el, value, onPick) {
    $$("button", el).forEach(b => {
      b.setAttribute("aria-pressed", String(b.dataset.v === String(value)));
      b.addEventListener("click", () => { $$("button", el).forEach(x => x.setAttribute("aria-pressed", String(x === b))); onPick(b.dataset.v); });
    });
  }
  function controls() {
    S3.store("svg2png", o);
    $("#scale").hidden = o.mode !== "scale"; $("#dims").hidden = o.mode === "scale";
    $("#wf").hidden = o.mode === "height"; $("#hf").hidden = o.mode === "width";
    $("#bg").disabled = o.transparent;
  }
  function add(name, text) {
    const it = { name, text, el: S3.h("li", { "class": "sv-item", tabindex: "0" }) };
    items.push(it); $("#list").appendChild(it.el);
    if (!sel) sel = it;
    return enqueue(it, run);
  }
  function enqueue(it, my) { queue = queue.then(() => work(it, my)); return queue; }
  async function work(it, my) {
    if (my !== run || items.indexOf(it) < 0) return;
    try {
      const r = await render(it.text, o);
      if (my !== run) return;
      if (it.res) URL.revokeObjectURL(it.res.url);
      r.url = URL.createObjectURL(r.blob); it.res = r; it.err = null;
    } catch (e) { it.err = e.message; if (it.res) URL.revokeObjectURL(it.res.url); it.res = null; }
    paint(it); refresh();
  }
  function rerender() { controls(); run++; const my = run; return Promise.all(items.map(it => enqueue(it, my))); }
  const later = S3.debounce(rerender, 250);
  function paint(it) {
    it.el.classList.toggle("is-sel", it === sel);
    it.el.textContent = "";
    it.el.appendChild(it.res ? S3.h("img", { src: it.res.url, alt: "", "class": "checker" }) : S3.h("span", { "class": "chip bad", text: "!" }));
    it.el.appendChild(S3.h("div", {}, [S3.h("b", { text: it.name, title: it.name }), S3.h("span", { text: it.err ? it.err : it.res ? it.res.nw + "×" + it.res.nh + " → " + it.res.w + "×" + it.res.h + " · " + S3.fmtBytes(it.res.blob.size) : "Rendering…" })]));
    const x = S3.h("button", { "class": "btn ghost small icon", "aria-label": "Remove " + it.name, html: S3.icon("x") });
    x.addEventListener("click", e => {
      e.stopPropagation(); items = items.filter(i => i !== it); it.el.remove();
      if (it.res) URL.revokeObjectURL(it.res.url);
      if (sel === it) { sel = items[0] || null; if (sel) paint(sel); }
      refresh();
    });
    it.el.appendChild(x);
  }
  function refresh() {
    const ok = items.filter(i => i.res);
    $("#empty").hidden = items.length > 0; $("#stage").hidden = !(sel && sel.res); $("#info").hidden = !(sel && sel.res);
    $("#one").disabled = !(sel && sel.res); $("#zip").disabled = !ok.length;
    $("#count").textContent = items.length ? ok.length + " of " + items.length : "";
    if (sel && sel.res) {
      $("#preview").src = sel.res.url;
      $("#dimChip").textContent = sel.res.w + " × " + sel.res.h + " px";
      $("#sizeChip").textContent = S3.fmtBytes(sel.res.blob.size);
      $("#srcChip").textContent = "SVG " + sel.res.nw + " × " + sel.res.nh;
    }
  }
  $("#list").addEventListener("click", e => {
    const li = e.target.closest(".sv-item"), it = items.filter(i => i.el === li)[0];
    if (!it) return;
    const old = sel; sel = it; if (old && old !== it) paint(old); paint(it); refresh();
  });
  $("#list").addEventListener("keydown", e => { if (e.key === "Enter" && e.target.classList.contains("sv-item")) e.target.click(); });

  S3.drop($("#drop"), async files => {
    for (const f of files) {
      if (f.size > 20 * 1024 * 1024) { S3.toast(f.name + " is over 20 MB", "error"); continue; }
      await add(f.name, await f.text());
    }
    S3.done();
  }, { accept: ".svg,image/svg+xml", multiple: true });
  $("#addCode").addEventListener("click", async () => {
    const t = $("#code").value.trim();
    if (!t) { S3.toast("Paste some SVG code first", "error"); return; }
    await add("pasted-" + (++pasted) + ".svg", t); S3.done();
  });
  seg($("#mode"), o.mode, v => { o.mode = v; rerender(); });
  seg($("#scale"), o.scale, v => { o.scale = +v; rerender(); });
  $("#w").value = o.w; $("#h").value = o.h;
  $("#w").addEventListener("input", e => { o.w = Math.min(MAX_SIDE, Math.max(1, Math.round(+e.target.value) || 1)); later(); });
  $("#h").addEventListener("input", e => { o.h = Math.min(MAX_SIDE, Math.max(1, Math.round(+e.target.value) || 1)); later(); });
  $("#transparent").checked = o.transparent; $("#bg").value = o.bg;
  $("#transparent").addEventListener("change", e => { o.transparent = e.target.checked; rerender(); });
  $("#bg").addEventListener("input", e => { o.bg = e.target.value; later(); });
  $("#one").addEventListener("click", () => { if (sel && sel.res) { S3.download(sel.res.blob, pngName(sel.name, o)); S3.done(); } });
  $("#zip").addEventListener("click", async () => {
    const used = {}, files = [];
    for (const it of items) {
      if (!it.res) continue;
      let n = pngName(it.name, o), k = 2; const base = n;
      while (used[n]) n = base.replace(/\.png$/, "-" + (k++) + ".png");
      used[n] = 1; files.push({ name: n, data: new Uint8Array(await it.res.blob.arrayBuffer()) });
    }
    S3.download(S3.zip(files), "svg-to-png.zip"); S3.done();
  });
  controls();

  // ---------- samples (inline SVG text, no remote files) ----------
  const LOGO = '<svg xmlns="' + SVGNS + '" viewBox="0 0 120 120"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#3dd6d0"/><stop offset="1" stop-color="#6d5dfc"/></linearGradient></defs>' +
    '<rect width="120" height="120" rx="28" fill="url(#g)"/><path d="M60 22l9 27h28l-23 17 9 28-23-17-23 17 9-28-23-17h28z" fill="#fff"/></svg>';
  const BADGE = '<svg xmlns="' + SVGNS + '" width="160" height="48" viewBox="0 0 160 48"><rect width="160" height="48" rx="24" fill="#1f2937"/><circle cx="24" cy="24" r="10" fill="#6ee7a8"/>' +
    '<rect x="44" y="18" width="96" height="12" rx="6" fill="#e5e7eb"/></svg>';
  window.S3_DEMO = async function () {
    $("#code").value = LOGO;
    await add("star-logo.svg", LOGO);
    await add("status-badge.svg", BADGE);
  };

  window.S3_SELFTEST = async function () {
    const px = async (blob, x, y) => {
      const u = URL.createObjectURL(blob), im = new Image(); im.src = u; await im.decode(); URL.revokeObjectURL(u);
      const c = document.createElement("canvas"); c.width = im.naturalWidth; c.height = im.naturalHeight;
      const g = c.getContext("2d"); g.drawImage(im, 0, 0); return { d: g.getImageData(x, y, 1, 1).data, w: c.width, h: c.height };
    };
    // Scripts and handlers inside the SVG must never run.
    delete window.__svgPwned;
    const evil = '<svg xmlns="' + SVGNS + '" viewBox="0 0 10 10" onload="window.__svgPwned=1"><script>window.__svgPwned=2<\/script><rect width="10" height="10" fill="#00ff00"/></svg>';
    const e = await render(evil, { mode: "scale", scale: 1, transparent: true });
    await new Promise(r => setTimeout(r, 50));
    const okSafe = window.__svgPwned === undefined && (await px(e.blob, 5, 5)).d[1] === 255;
    // 8x: crisp halves, right size, PNG bytes, transparent corner.
    const halves = '<svg xmlns="' + SVGNS + '" viewBox="0 0 10 10"><rect width="5" height="10" fill="#ff0000"/><rect x="5" width="5" height="10" fill="#0000ff"/></svg>';
    const a = await render(halves, { mode: "scale", scale: 8, transparent: true });
    const l = await px(a.blob, 20, 40), r = await px(a.blob, 60, 40), head = new Uint8Array(await a.blob.slice(0, 4).arrayBuffer());
    const dot = '<svg xmlns="' + SVGNS + '" width="40" height="40"><circle cx="20" cy="20" r="10" fill="#000"/></svg>';
    const t = await render(dot, { mode: "scale", scale: 1, transparent: true }), wbg = await render(dot, { mode: "scale", scale: 1, transparent: false, bg: "#ffffff" });
    const okDraw = a.w === 80 && a.h === 80 && l.w === 80 && l.d[0] === 255 && l.d[2] === 0 && r.d[2] === 255 && r.d[0] === 0 &&
      head[0] === 0x89 && head[1] === 0x50 && (await px(t.blob, 1, 1)).d[3] === 0 && (await px(wbg.blob, 1, 1)).d[0] === 255 && (await px(wbg.blob, 20, 20)).d[0] === 0;
    // Sizes: units, width-only, exact.
    const p1 = parse('<svg xmlns="' + SVGNS + '" width="1in" height="72pt"/>');
    const wOnly = await render('<svg xmlns="' + SVGNS + '" viewBox="0 0 100 50"/>', { mode: "width", w: 200, transparent: true });
    const ex = await render(halves, { mode: "exact", w: 30, h: 12, transparent: true });
    const okSize = p1.w === 96 && p1.h === 96 && wOnly.w === 200 && wOnly.h === 100 && ex.w === 30 && ex.h === 12 &&
      pngName("icon.svg", { mode: "scale", scale: 3 }) === "icon@3x.png" && pngName("a.svg", { mode: "width" }) === "a.png";
    let okBad = false; try { parse("<html><body>nope</body></html>"); } catch (err) { okBad = true; }
    let okBig = false; try { target(100, 100, { mode: "width", w: 20000 }); } catch (err) { okBig = true; }
    return (okSafe && okDraw && okSize && okBad && okBig) || { okSafe, okDraw, okSize, okBad, okBig };
  };
})();
