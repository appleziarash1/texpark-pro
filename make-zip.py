"""Build texpark-pro-download.zip - the one file the owner hands around.

An explicit allowlist, not a walk of the repo root. The root holds the app, the
build tooling, .git, and android-keystore.jks - the private key that signs the
APK. A walk swept all of it into the archive, and worse, the walk reached the
zip being written and recursed into it, so the file grew without bound instead
of finishing. Nothing outside this list ships.
"""
import os, zipfile, time

# A zip stores a modification time per entry, so two builds of identical content
# came out byte-different and left the committed .zip showing as modified after
# every run. Pin the stamp so a rebuild is reproducible.
WHEN = time.gmtime(int(os.environ.get('SOURCE_DATE_EPOCH', '1767225600')))[:6]


def add_(z, full, arc):
    info = zipfile.ZipInfo(arc, date_time=WHEN)
    info.compress_type = zipfile.ZIP_DEFLATED
    info.external_attr = 0o644 << 16
    with open(full, 'rb') as f:
        z.writestr(info, f.read())

# Derived from this file's own location, not a fixed path: CI checks the repo out
# under /home/runner/work, where a hardcoded /workspace/project makes the check
# abort with FileNotFoundError and fail a green build.
root = os.path.dirname(os.path.abspath(__file__))
out = os.path.join(root, 'texpark-pro-download.zip')
app = os.path.join(root, 'texpark-pro')

# The hostable app, as it sits in texpark-pro/. The launcher .bat files and
# main.js/package.json are what make the PC copy double-clickable.
APP_FILES = [
    'index.html',
    'css/app.css',
    'js/app.js',
    'js/db.js',
    'js/sync.js',
    'js/voice.js',
    'js/memoexport.js',
    'sw.js',
    'manifest.webmanifest',
    'icon-192.png',
    'icon-512.png',
    'Code.gs',
    'OPEN_APP.bat',
    'START_APP.bat',
    'CREATE_DESKTOP_SHORTCUT.bat',
    'main.js',
    'package.json',
]
# Copied in from elsewhere in the repo so the unzipped folder stands alone: the
# guide is what the owner reads before hosting, the APK is the app itself, and
# version.txt is written to the root by build.js, not into this folder.
APP_COPIES = {
    os.path.join(root, 'docs', 'HOSTING_BANGLA.txt'): 'HOSTING_BANGLA.txt',
    os.path.join(root, 'TexparkPro.apk'): 'TexparkPro.apk',
    os.path.join(root, 'version.txt'): 'version.txt',
}
TOP_FILES = {
    os.path.join(root, 'texpark-pro.html'): 'texpark-pro.html',
    os.path.join(root, 'TexparkPro.apk'): 'TexparkPro.apk',
    os.path.join(root, 'ANDROID_BANGLA.txt'): 'ANDROID_BANGLA.txt',
}
# The catalog pages go in under catalog/, mirroring the deployed site. They link
# to each other and up to the app with ../ paths, so flattening them to the zip
# root would break every link in the offline copy.
CATALOG_FILES = {
    os.path.join(root, 'catalog', 'index.html'): 'catalog/index.html',
    os.path.join(root, 'catalog', 'download.html'): 'catalog/download.html',
    os.path.join(root, 'catalog', 'catalog-pro-v1.html'): 'catalog/catalog-pro-v1.html',
}

if os.path.exists(out):
    os.remove(out)

z = zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED)
try:
    for name in APP_FILES:
        full = os.path.join(app, name)
        if not os.path.isfile(full):
            raise SystemExit('missing from texpark-pro/: ' + name)
        add_(z, full, "texpark-pro-app/" + name)
    for full, arc in APP_COPIES.items():
        if not os.path.isfile(full):
            raise SystemExit('missing from the repo: ' + full)
        add_(z, full, "texpark-pro-app/" + arc)
    for full, arc in TOP_FILES.items():
        if not os.path.isfile(full):
            raise SystemExit('missing from the repo: ' + full)
        add_(z, full, arc)
    for full, arc in CATALOG_FILES.items():
        if not os.path.isfile(full):
            raise SystemExit('missing from the repo: ' + full)
        add_(z, full, arc)
finally:
    z.close()

names = sorted(zipfile.ZipFile(out).namelist())
for n in names:
    print(' ', n)

# The key and the history must never travel in a file the owner passes around.
assert not any(n.endswith('.jks') or '.git' in n or 'keystore' in n for n in names), \
    'the signing key and the git history must never be published'
assert 'texpark-pro-app/index.html' in names, 'the folder must hold the app'
assert 'texpark-pro.html' in names, 'the single-file phone copy must ship'
assert 'TexparkPro.apk' in names, 'the APK must ship so the download stands alone'
assert 'catalog/index.html' in names, 'the offline catalog belongs in the zip'
print('OK: no secrets, no build tooling')
print('total', len(names), 'files,', round(os.path.getsize(out) / 1024), 'KB')
