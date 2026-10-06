/* Texpark Pro — save a memo as a picture (PNG) or as a PDF.

   The owner prints memos, but he also sends them on WhatsApp and keeps copies for
   his own records, so the memo has to leave the app as a file. Both formats come
   out of one renderer: the sheet's own HTML is wrapped in an SVG <foreignObject>
   and drawn onto a canvas. That way the download is the same sheet the screen and
   the printer show, instead of a second layout that slowly drifts away from it.

   No library is used. A PDF that carries one JPEG is a small, well-defined file -
   writing those few objects directly keeps the app self-contained, which matters
   because it must also run from a USB stick with no internet.

   The browser APIs here (Image, canvas, Blob, atob) do not exist in the Node test
   harness, so every entry point returns a value the caller can report rather than
   throwing: a phone that cannot rasterise should say so, not go blank. */

const MEMO_PAGE = { w: 794, h: 1123, margin: 36 };   // A4 at 96 dpi
const MEMO_PDF_PAGE = { w: 595.28, h: 841.89 };      // A4 in points

/* How tall the sheet is before it is drawn. The canvas has to be sized up front -
   an image cannot grow after it is drawn - so this is an estimate with headroom,
   not a measurement. Too tall only leaves white space at the bottom. */
function memoSheetHeight(m) {
  const rows = Math.max(1, (m.items || []).length);
  let h = 470 + rows * 34;
  if (m.note) h += 40;
  if (m.customerAddress) h += 18;
  const needed = h + MEMO_PAGE.margin * 2;
  return Math.max(MEMO_PAGE.h, Math.round(needed));
}

/* The sheet as one standalone SVG document.

   The stylesheet travels inside the SVG because an SVG loaded as an image is its
   own document: it inherits nothing from the page, so a sheet styled by
   css/app.css would download as plain black text on white. The page width is
   pinned here too, so the flex header and the two-column footer lay out the same
   way they do on screen. */
function memoSheetSVG(m) {
  const pad = MEMO_PAGE.margin;
  const w = MEMO_PAGE.w, inner = w - pad * 2;
  const h = memoSheetHeight(m);
  return '<svg xmlns="http://www.w3.org/2000/svg" width="' + w + '" height="' + h +
    '" viewBox="0 0 ' + w + ' ' + h + '">' +
    '<rect width="' + w + '" height="' + h + '" fill="#ffffff"/>' +
    '<style>' + MEMO_CSS +
      ' .memo-sheet{width:' + inner + 'px;max-width:none;margin:0}' +
      ' .memo-sheet .memo-top{border-radius:10px 10px 0 0}' +
    '</style>' +
    '<foreignObject x="' + pad + '" y="' + pad + '" width="' + inner + '" height="' + (h - pad * 2) + '">' +
      '<div xmlns="http://www.w3.org/1999/xhtml">' + memoSheet(m) + '</div>' +
    '</foreignObject></svg>';
}

function memoFileBase(m) {
  return 'memo-' + String(m.memoNo || 'draft').replace(/[^A-Za-z0-9._-]+/g, '-');
}

/* Turns a Blob into a download. Kept in one place so every export path triggers the
   download the same way and the object URL is released again - a memo saved a
   hundred times should not leak a hundred blobs. */
function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  if (typeof URL.revokeObjectURL === 'function') setTimeout(() => URL.revokeObjectURL(url), 4000);
}

/* Rasterises the sheet at `scale` and hands back the canvas.

   Returns a Promise because an SVG loaded into an <img> fires load asynchronously;
   the caller has to wait for it or the canvas is blank. */
function memoCanvas(m, scale) {
  return new Promise((resolve, reject) => {
    if (typeof Image !== 'function' || typeof document.createElement !== 'function') {
      reject(new Error('images cannot be created on this device'));
      return;
    }
    const w = MEMO_PAGE.w, h = memoSheetHeight(m);
    const svg = memoSheetSVG(m);
    const img = new Image();
    img.onload = () => {
      const cv = document.createElement('canvas');
      cv.width = Math.round(w * scale);
      cv.height = Math.round(h * scale);
      const ctx = cv.getContext('2d');
      if (!ctx) { reject(new Error('canvas khulche na')); return; }
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, cv.width, cv.height);
      ctx.drawImage(img, 0, 0, cv.width, cv.height);
      resolve(cv);
    };
    img.onerror = () => reject(new Error('could not render the memo as an image'));
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  });
}

function canvasToBlob(cv, type, quality) {
  return new Promise((resolve, reject) => {
    if (typeof cv.toBlob === 'function') {
      cv.toBlob(b => (b ? resolve(b) : reject(new Error('could not create the file'))), type, quality);
      return;
    }
    // Older WebViews have no toBlob; the data URL form always exists.
    const url = cv.toDataURL(type, quality);
    const bin = atob(url.split(',')[1]);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    resolve(new Blob([bytes], { type }));
  });
}

/* ---- the PDF writer ---- */

/* Latin-1 bytes of a string. A PDF is byte-addressed, so every offset in the xref
   table has to count bytes; a JPEG stream is not valid UTF-8 and would corrupt the
   offsets if it were carried as a JS string. */
function pdfBytes(str) {
  const out = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) out[i] = str.charCodeAt(i) & 0xff;
  return out;
}

/* A one-page PDF holding one JPEG.

   Deliberately minimal: catalog, page tree, the image XObject, and a content stream
   that scales the image to the page width. Anything more (fonts, text, outlines)
   would be a second renderer to keep in step with the sheet, which is exactly what
   this avoids. */
function pdfFromJPEG(jpeg, imgW, imgH) {
  const pw = MEMO_PDF_PAGE.w, ph = MEMO_PDF_PAGE.h, m = 24;
  const drawW = pw - m * 2;
  const drawH = drawW * (imgH / imgW);
  // A tall sheet is fitted to the page height as well, so nothing is cut off.
  const scale = drawH > ph - m * 2 ? (ph - m * 2) / drawH : 1;
  const w = drawW * scale, h = drawH * scale;
  const x = (pw - w) / 2, y = ph - m - h;

  const content = 'q\n' + w.toFixed(2) + ' 0 0 ' + h.toFixed(2) + ' ' +
    x.toFixed(2) + ' ' + y.toFixed(2) + ' cm\n/Im0 Do\nQ\n';

  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ' + pw + ' ' + ph + '] ' +
      '/Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /XObject /Subtype /Image /Width ' + imgW + ' /Height ' + imgH +
      ' /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ' +
      jpeg.length + ' >>\nstream\n',
    '<< /Length ' + content.length + ' >>\nstream\n' + content
  ];
  // Streams are assembled separately: object 4 carries binary data, so it cannot go
  // through the same string concatenation as the dictionaries around it.
  const head = '%PDF-1.4\n';
  const parts = [pdfBytes(head)];
  const offsets = [];
  let pos = head.length;
  const push = (s) => { const b = pdfBytes(s); parts.push(b); pos += b.length; };

  for (let i = 0; i < objs.length; i++) {
    offsets.push(pos);
    push((i + 1) + ' 0 obj\n' + objs[i]);
    if (i === 3) { parts.push(jpeg); pos += jpeg.length; push('\nendstream\nendobj\n'); }
    else if (i === 4) { push('endstream\nendobj\n'); }
    else { push('\nendobj\n'); }
  }

  const xrefPos = pos;
  let xref = 'xref\n0 ' + (objs.length + 1) + '\n0000000000 65535 f \n';
  offsets.forEach(o => { xref += String(o).padStart(10, '0') + ' 00000 n \n'; });
  xref += 'trailer\n<< /Size ' + (objs.length + 1) + ' /Root 1 0 R >>\nstartxref\n' +
    xrefPos + '\n%%EOF\n';
  push(xref);

  const total = parts.reduce((a, b) => a + b.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  parts.forEach(b => { out.set(b, at); at += b.length; });
  return out;
}

/* ---- what the buttons call ---- */

/* The JPEG bytes a PDF needs, taken from the same canvas the PNG is drawn on. */
function memoJPEGBytes(cv) {
  return new Promise((resolve, reject) => {
    if (typeof cv.toDataURL !== 'function') { reject(new Error('canvas toDataURL is not available')); return; }
    const url = cv.toDataURL('image/jpeg', 0.92);
    const bin = atob(url.split(',')[1]);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    resolve(bytes);
  });
}

function saveMemoPNG(m) {
  if (!m) return;
  memoCanvas(m, 2)
    .then(cv => canvasToBlob(cv, 'image/png'))
    .then(b => { downloadBlob(b, memoFileBase(m) + '.png'); toast('Memo saved as PNG: ' + memoFileBase(m) + '.png'); })
    .catch(e => alert('Could not save the PNG: ' + e.message));
}

function saveMemoPDF(m) {
  if (!m) return;
  memoCanvas(m, 2)
    .then(cv => memoJPEGBytes(cv).then(bytes =>
      ({ bytes, w: cv.width, h: cv.height })))
    .then(j => {
      const pdf = pdfFromJPEG(j.bytes, j.w, j.h);
      downloadBlob(new Blob([pdf], { type: 'application/pdf' }), memoFileBase(m) + '.pdf');
      toast('Memo saved as PDF: ' + memoFileBase(m) + '.pdf');
    })
    .catch(e => alert('Could not save the PDF: ' + e.message));
}

/* What "Print" already did: put the sheet in the print area and hand it to the
   printer dialog, which also offers "Save as PDF" on every platform. */
function printMemoSheet(m) {
  if (!m) return;
  document.getElementById('printArea').innerHTML = memoSheet(m);
  window.print();
}

/* A tiny status line. The phone has no console, so an export that worked has to say
   so somewhere the owner will see. The element is made on demand: it is only ever
   needed after a tap, so it costs the first paint nothing. */
function toast(msg) {
  if (typeof document === 'undefined' || !document.body) return;
  let host = document.getElementById('toastHost');
  if (!host) {
    host = document.createElement('div');
    host.id = 'toastHost';
    host.className = 'toast';
    document.body.appendChild(host);
  }
  host.textContent = msg;
  host.classList.add('show');
  setTimeout(() => host.classList.remove('show'), 2600);
}
