"""Build texpark-hosting.zip - the folder to drop on a host or push to Pages.

An explicit allowlist, not a walk of the repo. The repo root now holds the app
*and* the build tooling, so a walk would sweep in android-build/ scratch, the
.git directory, and android-keystore.jks. That last one is the private key that
signs the APK: publishing it would let anyone sign an APK that Android accepts
as an update to the installed one. Nothing outside this list ships.
"""
import zipfile, os
root = '/workspace/project'
out = os.path.join(root, 'texpark-hosting.zip')

SITE_FILES = [
    'index.html',           # the app itself; the APK derives its update paths from here
    'version.txt',          # build stamp the APK's bundled build is compared by
    'js/app.js',            # where the update check reads APP_VERSION from
    'js/db.js',
    'js/sync.js',
    'js/voice.js',
    'css/app.css',
    'sw.js',
    'manifest.webmanifest',
    'icon-192.png',
    'icon-512.png',
    'Code.gs',              # paste into Apps Script; not loaded by the page
    'TexparkPro.apk',       # so the app download link outlives any one host
]

if os.path.exists(out):
    os.remove(out)
z = zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED)

# index.html is stored at the TOP LEVEL of the archive. If it is nested
# (app/index.html) the host serves 404 at "/", which is the mistake this flat
# zip exists to prevent.
for name in SITE_FILES:
    full = os.path.join(root, name)
    if not os.path.isfile(full):
        raise SystemExit('missing from the repo: ' + name)
    z.write(full, name)
# No catch-all rewrite is written on purpose. "/* /index.html 200" looks
# harmless, but Netlify would then answer every unknown path with the app HTML.
# A single missing file in a deploy would be served as a valid-looking page
# instead of a 404, so a half-uploaded release would look complete and the
# installer could save markup under a .js name. Netlify already serves
# index.html at "/", so the fallback buys nothing worth that risk.
z.close()

# The APK is already in SITE_FILES, so it is not added a second time here.
names = sorted(zipfile.ZipFile(out).namelist())
for n in names:
    print(' ', n)
assert 'index.html' in names, 'index.html must sit at the archive root'
assert 'js/app.js' in names, 'the phone reads its version out of js/app.js'
assert 'TexparkPro.apk' in names, 'the APK must ship so the site can offer it'
assert '_redirects' not in names, 'a catch-all redirect would hide missing files'
assert not any(n.endswith('.jks') or n.startswith('.git/') for n in names), \
    'the signing key must never be published'
print('OK: index.html is at the top level')
print('total', len(names), 'files,', round(os.path.getsize(out) / 1024), 'KB')

