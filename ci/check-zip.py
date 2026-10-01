"""Refuse to publish a hosting zip that carries anything private.

The repo root holds the app and the build tooling together, so a zip built by
walking it would pick up android-keystore.jks - the private key that signs the
APK. Anyone holding it can sign an APK that Android treats as an update to the
installed one, and .git would leak the whole history.
"""
import os, zipfile, sys

names = zipfile.ZipFile('texpark-hosting.zip').namelist()
forbidden = [n for n in names if n.endswith('.jks') or n.startswith('.git/') or '.git/' in n]
if forbidden:
    sys.exit('refusing to publish: ' + ', '.join(forbidden))

required = ['index.html', 'js/app.js', 'TexparkPro.apk', 'version.txt']
missing = [n for n in required if n not in names]
if missing:
    sys.exit('hosting zip is missing: ' + ', '.join(missing))

print('zip is clean:', len(names), 'files')

# The download zip is the file the owner emails or copies to a USB stick, so the
# same two things must hold there. It is built by make-zip.py, whose allowlist is
# what keeps .git and the signing key out; this is the check that would catch the
# allowlist being widened by accident.
if os.path.isfile('texpark-pro-download.zip'):
    dnames = zipfile.ZipFile('texpark-pro-download.zip').namelist()
    leaked = [n for n in dnames if n.endswith('.jks') or '.git' in n or 'keystore' in n]
    if leaked:
        sys.exit('refusing to publish: ' + ', '.join(leaked))
    for n in ('texpark-pro-app/index.html', 'texpark-pro.html', 'TexparkPro.apk'):
        if n not in dnames:
            sys.exit('download zip is missing: ' + n)
    print('download zip is clean:', len(dnames), 'files')
