"""Fail a push that would break the app on a phone that already installed the APK.

Two things have to hold, and neither is visible from the source alone:

1. Every path index.html asks for must exist in the repo. The installed app
   resolves those same relative paths against the host, so a file that is present
   locally but missing from a deploy makes the phone fetch a 404 page and render a
   blank screen.

2. version.txt must equal APP_VERSION in js/app.js. The APK stamps itself with
   version.txt and the phone compares that stamp against the build it unpacked; if
   they disagree the app reinstalls its bundled build on every launch.
"""
import os, re, sys

os.chdir(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..'))

html = open('index.html', encoding='utf-8').read()
missing = [p for p in re.findall(r'(?:src|href)="([^":#]+)"', html)
           if not p.startswith(('http', '//', 'mailto'))
           and not os.path.isfile(p)]
if missing:
    sys.exit('index.html points at files that are absent: ' + ', '.join(sorted(set(missing))))

app = open('js/app.js', encoding='utf-8').read()
m = re.search(r"APP_VERSION = '([^']+)'", app)
if not m:
    sys.exit('js/app.js has no APP_VERSION - the update check reads it from there')
app_version = m.group(1)
stamp = open('version.txt', encoding='utf-8').read().strip()
if app_version != stamp:
    sys.exit('version.txt (%s) != js/app.js APP_VERSION (%s)' % (stamp, app_version))

print('index.html references resolve; version %s is consistent' % stamp)
