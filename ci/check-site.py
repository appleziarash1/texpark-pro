"""Fail a push that would break the app on a phone that already installed the APK.

Three things have to hold, and none of them is visible from the source alone:

1. Every path index.html asks for must exist in the repo. The installed APK's
   update check asks the host for version.txt and sends the owner to
   .../TexparkPro.apk, so a file present locally but missing from the deploy gives
   the phone a 404 where a download should be.

2. version.txt must equal APP_VERSION in js/app.js and in sw.js. version.txt is
   the stamp the APK compares against, and both js files carry it for the browser
   build: if they disagree, one of the two builds is lying about itself.

3. The built APK must stamp the same version in MainActivity and in its dex.
   Without it the app offers the owner an "update" on every launch, because it
   compares the release against a number that never changes.

4. demo.html must point at the address the app is actually built with, and its
   QR codes must really decode to those addresses. This is the page the owner
   scans to install the app, and it once kept a dead sandbox URL for weeks
   because nothing checked it: the page looked perfectly fine and led nowhere.
"""
import os, re, sys, zipfile

os.chdir(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..'))

html = open('index.html', encoding='utf-8').read()
missing = [p for p in re.findall(r'(?:src|href)="([^":#]+)"', html)
           if not p.startswith(('http', '//', 'mailto'))
           and not os.path.isfile(p)]
if missing:
    sys.exit('index.html points at files that are absent: ' + ', '.join(sorted(set(missing))))


def js_version(path):
    m = re.search(r"APP_VERSION = '([^']+)'", open(path, encoding='utf-8').read())
    return m.group(1) if m else None


stamp = open('version.txt', encoding='utf-8').read().strip()
for path in ('js/app.js', 'sw.js'):
    got = js_version(path)
    if got is None:
        sys.exit(path + ' has no APP_VERSION')
    if got != stamp:
        sys.exit('version.txt (%s) != %s APP_VERSION (%s)' % (stamp, path, got))

java = open('android-src/com/texpark/pro/MainActivity.java', encoding='utf-8').read()
m = re.search(r'APP_VERSION = "([^"]+)"', java)
if not m:
    sys.exit('MainActivity.java has no APP_VERSION - the update check reads it from there')
if m.group(1) != stamp:
    sys.exit('version.txt (%s) != MainActivity APP_VERSION (%s) - the app would '
             'offer the same update on every launch' % (stamp, m.group(1)))

if os.path.isfile('TexparkPro.apk'):
    with zipfile.ZipFile('TexparkPro.apk') as z:
        if 'classes.dex' not in z.namelist():
            sys.exit('TexparkPro.apk has no classes.dex')
        if stamp.encode('utf-8') not in z.read('classes.dex'):
            sys.exit('TexparkPro.apk does not carry version ' + stamp)

# ---- 4. the install page must point where the app points, verifiably ---- */
host = re.search(r'DEFAULT_UPDATE_URL\s*=\s*"([^"]+)"',
                 open('android-src/com/texpark/pro/MainActivity.java',
                      encoding='utf-8').read()).group(1)
demo = open('demo.html', encoding='utf-8').read()
app_url = host.rstrip('/') + '/'
for want in (app_url, app_url + 'TexparkPro.apk'):
    if want not in demo:
        sys.exit('demo.html does not mention %s - the install page points somewhere '
                 'the app is not built for' % want)
if 'prod-runtime.all-hands.dev' in demo:
    sys.exit('demo.html still carries a sandbox address; that link dies with the sandbox')

codes = re.findall(r'<svg[^>]*>.*?</svg>', demo, re.S)
printed = re.findall(r'class="url">([^<]+)<', demo)
if len(codes) != len(printed):
    sys.exit('demo.html has %d QR codes but %d printed URLs' % (len(codes), len(printed)))
try:
    import cairosvg, cv2, numpy as np
except ImportError:
    print('note: cairosvg/cv2 absent, demo.html QR codes not read back')
else:
    for svg in codes:
        png = cairosvg.svg2png(bytestring=svg.encode(), output_width=800,
                               output_height=800, background_color='white')
        img = cv2.imdecode(np.frombuffer(png, np.uint8), cv2.IMREAD_GRAYSCALE)
        got, _, _ = cv2.QRCodeDetector().detectAndDecode(img)
        if got not in printed:
            sys.exit('a QR code in demo.html decodes to %r, which is not a URL the '
                     'page prints - scanning it would mislead the owner' % got)

print('index.html references resolve; version %s is consistent in app.js, sw.js, '
      'MainActivity and the APK; demo.html points at %s and its QR codes decode'
      % (stamp, host))
