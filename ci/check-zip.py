"""Refuse to publish a hosting zip that carries anything private.

The repo root holds the app and the build tooling together, so a zip built by
walking it would pick up android-keystore.jks - the private key that signs the
APK. Anyone holding it can sign an APK that Android treats as an update to the
installed one, and .git would leak the whole history.
"""
import zipfile, sys

names = zipfile.ZipFile('texpark-hosting.zip').namelist()
forbidden = [n for n in names if n.endswith('.jks') or n.startswith('.git/') or '.git/' in n]
if forbidden:
    sys.exit('refusing to publish: ' + ', '.join(forbidden))

required = ['index.html', 'js/app.js', 'TexparkPro.apk', 'version.txt']
missing = [n for n in required if n not in names]
if missing:
    sys.exit('hosting zip is missing: ' + ', '.join(missing))

print('zip is clean:', len(names), 'files')
