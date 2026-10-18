"""Validate the deployed browser app without coupling it to the retired APK build."""
import os
import re
import sys

os.chdir(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..'))

html = open('index.html', encoding='utf-8').read()
missing = [p for p in re.findall(r'(?:src|href)="([^":#]+)"', html)
           if not p.startswith(('http', '//', 'mailto'))
           and not os.path.isfile(p)]
if missing:
    sys.exit('index.html points at files that are absent: ' + ', '.join(sorted(set(missing))))


def js_version(path):
    match = re.search(r"APP_VERSION = '([^']+)'", open(path, encoding='utf-8').read())
    return match.group(1) if match else None


stamp = open('version.txt', encoding='utf-8').read().strip()
for path in ('js/app.js', 'sw.js', 'texpark-pro/js/app.js', 'texpark-pro/sw.js'):
    version = js_version(path)
    if version is None:
        sys.exit(path + ' has no APP_VERSION')
    if version != stamp:
        sys.exit('version.txt (%s) != %s APP_VERSION (%s)' % (stamp, path, version))

print('website assets and browser build versions are consistent')
