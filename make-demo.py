#!/usr/bin/env python3
"""Regenerates demo.html: the one page the owner opens to install the app.

The page carries two QR codes - one for the APK, one for the web app - and the
URLs are printed next to them. Both codes are drawn here from segno rather than
being pasted in by hand, because a hand-pasted code is exactly what went wrong:
the page kept pointing at a temporary sandbox address long after hosting had
moved to a permanent one, so scanning it led nowhere.

The host is read from MainActivity, so the page cannot drift away from the
address the installed app actually checks for updates.
"""
import io
import re
import sys
from pathlib import Path

try:
    import segno
except ImportError:
    sys.exit('segno is needed: pip install segno')

ROOT = Path(__file__).resolve().parent
MAIN = ROOT / 'android-src' / 'com' / 'texpark' / 'pro' / 'MainActivity.java'
OUT = ROOT / 'demo.html'

HOST = re.search(r'DEFAULT_UPDATE_URL\s*=\s*"([^"]+)"', MAIN.read_text(encoding='utf-8')).group(1)
APP_URL = HOST.rstrip('/') + '/'
APK_URL = APP_URL + 'TexparkPro.apk'
GUIDE_URL = APP_URL + 'ANDROID_BANGLA.txt'

TEMPLATE = """<!DOCTYPE html>
<html lang="bn"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Texpark Pro &mdash; Get the app</title>
<style>
 body{margin:0;font-family:system-ui,'Segoe UI',sans-serif;background:#eef3f9;color:#233}
 .wrap{max-width:820px;margin:0 auto;padding:18px}
 header{background:#12366b;color:#fff;padding:20px;border-radius:14px}
 header h1{margin:0;font-size:23px}
 header p{margin:6px 0 0;opacity:.85;font-size:14px}
 .grid{display:grid;gap:16px;margin-top:18px}
 @media(min-width:700px){.grid{grid-template-columns:1fr 1fr}}
 .card{background:#fff;border-radius:14px;padding:18px;box-shadow:0 2px 10px rgba(18,54,107,.09)}
 .card h2{margin:0 0 4px;font-size:18px;color:#12366b}
 .card .sub{font-size:13px;color:#5b6b82;margin-bottom:12px}
 .qr{display:flex;justify-content:center;background:#fff;padding:8px;border:1px solid #dde6f1;border-radius:10px}
 .qr svg{width:100%;max-width:240px;height:auto}
 .url{display:block;margin-top:12px;font-size:12px;word-break:break-all;background:#f4f8fd;
      border:1px solid #dde6f1;border-radius:8px;padding:9px;color:#12366b}
 .note{background:#fff6e5;border:1px solid #f0d9a8;border-radius:12px;padding:14px;margin-top:16px;font-size:14px}
 .note b{color:#8a5a00}
 .cred{background:#eaf5ec;border:1px solid #bfe0c6;border-radius:12px;padding:14px;margin-top:16px;font-size:14px}
 code{background:#eef3f9;padding:2px 6px;border-radius:5px;font-size:13px;color:#12366b}
 .steps{font-size:14px;line-height:1.8;padding-left:20px;margin:8px 0 0}
 .foot{text-align:center;color:#7b8aa0;font-size:12px;margin:22px 0 8px}
</style></head><body><div class="wrap">
<header>
  <h1>Texpark Pro &mdash; get the app</h1>
  <p>TEXPARK BUYING HOUSE &middot; scan the QR with your phone camera</p>
</header>

<div class="grid">
  <div class="card">
    <h2>1. Android app (APK)</h2>
    <div class="sub">The real app &mdash; memos, stock, accounts and more</div>
    __QR_APK__
    <code class="url">__APK__</code>
    <ol class="steps">
      <li>Scan the QR &mdash; the APK file downloads</li>
      <li>Tap the file and Android will ask you to <b>Install</b></li>
      <li>The first time it asks for <b>"Install unknown apps"</b> permission &mdash; tap Allow</li>
      <li>The app opens. Sign in with your account</li>
    </ol>
  </div>

  <div class="card">
    <h2>2. In a PC/phone browser (web app)</h2>
    <div class="sub">Open this to print memos from the PC</div>
    __QR_APP__
    <code class="url">__APP__</code>
    <ol class="steps">
      <li>Open this link in the PC browser</li>
      <li>Memos, stock, accounts &mdash; all in one place</li>
      <li>Printing from the PC puts the memo on paper</li>
    </ol>
  </div>
</div>

<div class="note">
  <b>This link is permanent &mdash; it will not go away.</b>
  <ol class="steps">
    <li>The app's data stays on your phone &mdash; memos, stock and customers do not go anywhere</li>
    <li><b>Back up regularly:</b> Settings &rarr; Backup / Data</li>
    <li>Phone and PC can share one dataset &mdash; in the app's Settings &rarr; Sync address,
        paste the Google Sheet link (then the two keep in step by themselves)</li>
    <li>Step-by-step Bangla guide: <a href="__GUIDE__">ANDROID_BANGLA.txt</a></li>
  </ol>
</div>

<div class="foot">Texpark Pro Business Manager</div>
</div></body></html>
"""


def qr_svg(url, mm):
    """The QR as inline SVG, sized in millimetres like the rest of the page."""
    q = segno.make(url, error='m')
    buf = io.BytesIO()
    q.save(buf, kind='svg', scale=1, border=2, dark='#000', xmldecl=False,
           svgns=True, nl=False)
    svg = buf.getvalue().decode('utf-8')
    # segno sizes by module; give the viewer mm and a viewBox so the modules stay
    # whole numbers when it scales.
    svg = re.sub(r'^<svg([^>]*?)width="[^"]*"\s*height="[^"]*"',
                 r'<svg\1width="%dmm" height="%dmm"' % (mm, mm), svg, count=1)
    if 'viewBox=' not in svg:
        dim = len(q.matrix) + 4
        svg = svg.replace('<svg ', '<svg viewBox="0 0 %d %d" ' % (dim, dim), 1)
    return svg


def verify(html):
    """Read the codes back. An undecodable QR is worse than none: it looks right.

    cv2 is only needed for this check, not for writing the page, so a machine
    without it still gets a usable demo.html - it just cannot prove the codes.
    """
    try:
        import cairosvg
        import cv2
        import numpy as np
    except ImportError:
        print('note: cv2/cairosvg absent, QR codes written but not read back')
        return
    svgs = re.findall(r'<svg[^>]*>.*?</svg>', html, re.S)
    printed = re.findall(r'class="url">([^<]+)<', html)
    assert len(svgs) == len(printed) == 2, 'expected 2 codes and 2 printed URLs'
    for svg in svgs:
        png = cairosvg.svg2png(bytestring=svg.encode(), output_width=800,
                               output_height=800, background_color='white')
        img = cv2.imdecode(np.frombuffer(png, np.uint8), cv2.IMREAD_GRAYSCALE)
        got, _, _ = cv2.QRCodeDetector().detectAndDecode(img)
        assert got in printed, 'a QR decodes to %r, which is not printed on the page' % got
        print('QR reads back: %s' % got)


def main():
    html = (TEMPLATE.replace('__QR_APK__', qr_svg(APK_URL, 44))
                    .replace('__QR_APP__', qr_svg(APP_URL, 40))
                    .replace('__APK__', APK_URL)
                    .replace('__APP__', APP_URL)
                    .replace('__GUIDE__', GUIDE_URL))
    verify(html)
    OUT.write_text(html, encoding='utf-8')
    print('wrote %s from host %s' % (OUT.name, HOST))


if __name__ == '__main__':
    main()
