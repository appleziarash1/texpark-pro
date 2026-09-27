#!/usr/bin/env python3
"""Builds Texpark Pro.apk (Android) from android-src/ + texpark-deploy/.

The web app is wrapped INSIDE the APK (assets/site), so the app opens with no
internet, never shows a blank page because a host is down, and needs no setup
address on first launch. The hosted site is only asked for a newer build, which
MainActivity/AppInstaller downloads and swaps in for the next launch.

Runs on JDK + Android SDK build-tools only, so there is no Gradle download.
"""
import os
import shutil
import struct
import subprocess
import sys
import zipfile
import zlib

ROOT = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(ROOT, 'android-src')
BUILD = os.path.join(ROOT, 'android-build')
SDK = os.environ.get('ANDROID_HOME', '/opt/android-sdk')
PLATFORM = os.path.join(SDK, 'platforms', 'android-34', 'android.jar')

# The deploy folder is the single source of the app the APK ships. build.js
# writes it, so the APK can never wrap a stale app.
DEPLOY = os.path.join(ROOT, 'texpark-deploy')


def check_referenced_files(site):
    """Every local href/src in index.html must exist in the wrapped app.

    Catches the case apksigner cannot: a stylesheet or script that never made
    it into the APK, which installs cleanly and shows a broken screen.
    """
    import re
    html = open(os.path.join(site, 'index.html'), encoding='utf-8').read()
    refs = re.findall(r'(?:href|src)\s*=\s*"([^"]+)"', html)
    missing = []
    for ref in refs:
        if ref.startswith(('http://', 'https://', 'data:', '#', 'mailto:')):
            continue
        ref = ref.split('?')[0].split('#')[0]
        if not ref or ref in ('sw.js', 'manifest.webmanifest'):
            continue  # the service worker is deliberately left out of the APK
        if not os.path.isfile(os.path.join(site, ref)):
            missing.append(ref)
    if missing:
        raise SystemExit('index.html asks for files the APK does not carry: '
                         + ', '.join(sorted(set(missing))))
    print('   every local file index.html asks for is wrapped (%d checked)' % len(refs))


def newest_build_tools(sdk):
    """Highest installed build-tools version.

    build-tools 34.0.0 ships a d8 that crashes with an internal
    NullPointerException on anonymous inner classes, so the newest is used
    rather than a pinned version.
    """
    root = os.path.join(sdk, 'build-tools')
    versions = sorted(os.listdir(root), key=lambda v: [int(p) for p in v.split('.')])
    return os.path.join(root, versions[-1])


BT = newest_build_tools(SDK)
OUT = os.path.join(ROOT, 'TexparkPro.apk')

PACKAGE = 'com.texpark.pro'
APP_NAME = 'Texpark Pro'
MIN_SDK = 21
TARGET_SDK = 34


def version_code_of(name):
    """Play-style integer version code from a 2026-09-22.7 style name.

    Just the digits: 2026-09-22.7 -> 202609227 and 2026-09-22.10 -> 2026092210.
    Because the month and day are always two digits, the ten-digit value for
    revision 10 still sorts above the nine-digit one for revision 9.
    """
    digits = ''.join(c for c in name if c.isdigit())
    return int(digits) if digits else 1


def run(cmd, **kw):
    print('  $', ' '.join(str(c) for c in cmd))
    r = subprocess.run(cmd, capture_output=True, text=True, **kw)
    if r.returncode != 0:
        print(r.stdout[-4000:])
        print(r.stderr[-4000:])
        raise SystemExit('FAILED: ' + ' '.join(str(c) for c in cmd))
    if r.stderr.strip():
        print('   ', r.stderr.strip()[:500])
    return r.stdout


# ---------------------------------------------------------------- PNG helpers
def png_chunks(data):
    assert data[:8] == b'\x89PNG\r\n\x1a\n', 'not a png'
    out, i = [], 8
    while i < len(data):
        (ln,) = struct.unpack('>I', data[i:i + 4])
        typ = data[i + 4:i + 8]
        out.append((typ, data[i + 8:i + 8 + ln]))
        i += 12 + ln
    return out


def png_write(path, chunks):
    body = b''.join(
        struct.pack('>I', len(d)) + t + d + struct.pack('>I', zlib.crc32(t + d) & 0xffffffff)
        for t, d in chunks)
    with open(path, 'wb') as f:
        f.write(b'\x89PNG\r\n\x1a\n' + body + b'IEND' + struct.pack('>I', 0))


def tint_png(src, dst, rgb):
    """Recolour the white parts of a logo, keeping alpha and shape."""
    chunks = png_chunks(open(src, 'rb').read())
    out = []
    for typ, d in chunks:
        if typ == b'IHDR':
            w, h = struct.unpack('>II', d[:8])
            bd, ct = d[8], d[9]
            assert bd == 8 and ct in (4, 6), 'expected 8-bit RGBA/greyscale+alpha'
            nch = 4 if ct == 6 else 2
            raw = zlib.decompress(next(x for t, x in chunks if t == b'IDAT'))
            stride = w * nch + 1
            # per-row: just replace colour channels, leave alpha untouched
            rows = []
            for y in range(h):
                line = bytearray(raw[y * stride:(y + 1) * stride])
                for x in range(w):
                    o = 1 + x * nch
                    line[o], line[o + 1], line[o + 2] = rgb
                rows.append(bytes(line))
            out.append((b'IDAT', zlib.compress(b''.join(rows), 9)))
        else:
            out.append((typ, d))
    png_write(dst, out)
    return w, h


def main():
    if not os.path.isdir(BT):
        raise SystemExit('Missing Android build-tools at ' + BT)
    if not os.path.isfile(os.path.join(DEPLOY, 'index.html')):
        raise SystemExit('Missing web app in ' + DEPLOY + ' - run: node texpark-pro/build.js')
    if os.path.exists(BUILD):
        shutil.rmtree(BUILD)
    for d in ['res', 'gen', 'obj', 'classes', 'dex', 'apk', 'assets']:
        os.makedirs(os.path.join(BUILD, d), exist_ok=True)
    res, gen, obj = (os.path.join(BUILD, d) for d in ('res', 'gen', 'obj'))
    assets = os.path.join(BUILD, 'assets')

    # ------------------------------------------------------------ the app itself
    # Everything the WebView loads is copied under assets/site. version.txt is
    # the stamp the APK's own bundled build is compared by, so it travels too.
    site = os.path.join(assets, 'site')
    os.makedirs(site, exist_ok=True)
    for name in ['index.html', 'version.txt', 'sw.js',
                 'manifest.webmanifest', 'icon-192.png', 'icon-512.png', 'Code.gs']:
        src = os.path.join(DEPLOY, name)
        if os.path.isfile(src):
            shutil.copy(src, os.path.join(site, name))
        else:
            print('   warn: deploy is missing ' + name)
    for sub in ['js', 'css']:
        s = os.path.join(DEPLOY, sub)
        if not os.path.isdir(s):
            continue
        os.makedirs(os.path.join(site, sub), exist_ok=True)
        for name in sorted(os.listdir(s)):
            shutil.copy(os.path.join(s, name), os.path.join(site, sub, name))

    # The service worker would try to cache the app out from under the update
    # mechanism, and the in-app updater already covers offline. It stays in the
    # hosted copy, not in the APK.
    sw = os.path.join(site, 'sw.js')
    if os.path.exists(sw):
        os.remove(sw)

    with open(os.path.join(DEPLOY, 'version.txt')) as f:
        version = f.read().strip() or '0'
    print('== app version in APK: ' + version + ' ==')

    # A file index.html asks for but the APK does not carry is the one defect
    # that gets past apksigner: the app installs, opens, and is unstyled or
    # dead in one screen the owner may not visit until it matters.
    check_referenced_files(site)

    # 2026-09-22.7 -> 2026092207. Android only compares the code, and a fixed
    # 1 would silently refuse every future APK as an update.
    version_code = version_code_of(version)
    version_name = version.replace('_', '.')

    # ------------------------------------------------------------ resources
    for d in ['drawable', 'mipmap-anydpi-v26', 'values']:
        os.makedirs(os.path.join(res, d), exist_ok=True)

    # The supplied icon is already the brand navy with the pink wordmark, so it
    # ships as-is rather than being recoloured.
    icon_src = os.path.join(ROOT, 'texpark-deploy', 'icon-512.png')
    shutil.copy(icon_src, os.path.join(res, 'drawable', 'ic_launcher.png'))
    shutil.copy(icon_src, os.path.join(res, 'drawable', 'ic_launcher_fg.png'))
    w, h = 512, 512

    open(os.path.join(res, 'drawable', 'ic_bg.xml'), 'w').write(
        '<?xml version="1.0" encoding="utf-8"?>\n'
        '<shape xmlns:android="http://schemas.android.com/apk/res/android"'
        ' android:shape="rectangle">'
        '<solid android:color="#12366b"/></shape>\n')
    open(os.path.join(res, 'mipmap-anydpi-v26', 'ic_launcher.xml'), 'w').write(
        '<?xml version="1.0" encoding="utf-8"?>\n'
        '<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">'
        '  <background android:drawable="@drawable/ic_bg"/>'
        '  <foreground android:drawable="@drawable/ic_launcher_fg"/>'
        '</adaptive-icon>\n')

    open(os.path.join(res, 'values', 'strings.xml'), 'w').write(
        '<?xml version="1.0" encoding="utf-8"?>\n<resources>\n'
        '  <string name="app_name">%s</string>\n'
        '  <string name="enter_url">Apnar Texpark Pro site-er address din</string>\n'
        '  <string name="url_hint">https://apnar-site.netlify.app</string>\n'
        '  <string name="start">Shuru korun</string>\n'
        '  <string name="bad_url">Address ta thik noy. https:// diye shuru korun.</string>\n'
        '</resources>\n' % APP_NAME)

    # ------------------------------------------------------------ manifest
    manifest = os.path.join(SRC, 'AndroidManifest.xml')
    shutil.copy(manifest, os.path.join(BUILD, 'AndroidManifest.xml'))

    # ------------------------------------------------------------ compile
    print('== aapt2 compile ==')
    res_zip = os.path.join(BUILD, 'res.zip')
    run([os.path.join(BT, 'aapt2'), 'compile', '--dir', res, '-o', res_zip])
    print('== aapt2 link ==')
    apk_unsigned = os.path.join(BUILD, 'apk', 'unsigned.apk')
    run([os.path.join(BT, 'aapt2'), 'link',
         '-o', apk_unsigned,
         '-I', PLATFORM,
         '--manifest', os.path.join(BUILD, 'AndroidManifest.xml'),
         '-R', res_zip,
         '-A', assets,
         '--java', gen,
         '--min-sdk-version', str(MIN_SDK),
         '--target-sdk-version', str(TARGET_SDK),
         '--version-code', str(version_code),
         '--version-name', version_name,
         '--auto-add-overlay'])

    # ------------------------------------------------------------ java
    print('== javac ==')
    java_files = []
    for r, d, files in os.walk(SRC):
        java_files += [os.path.join(r, f) for f in files if f.endswith('.java')]
    for r, d, files in os.walk(gen):
        java_files += [os.path.join(r, f) for f in files if f.endswith('.java')]
    classes = os.path.join(BUILD, 'classes')
    run(['javac', '-source', '8', '-target', '8', '-nowarn',
         '-bootclasspath', PLATFORM, '-classpath', PLATFORM,
         '-d', classes] + java_files)

    # ------------------------------------------------------------ dex
    print('== d8 ==')
    class_files = []
    for r, d, files in os.walk(classes):
        class_files += [os.path.join(r, f) for f in files if f.endswith('.class')]
    run([os.path.join(BT, 'd8'), '--release', '--min-api', str(MIN_SDK),
         '--lib', PLATFORM, '--output', obj] + class_files)
    dex = os.path.join(BUILD, 'dex', 'classes.dex')
    produced = [f for f in os.listdir(obj) if f.endswith('.dex')]
    if produced != ['classes.dex']:
        raise SystemExit('expected one classes.dex, got %r' % produced)
    shutil.copy(os.path.join(obj, 'classes.dex'), dex)

    # ------------------------------------------------------------ package
    print('== add dex to apk ==')
    # The zip binary is not present in this image (nor in a bare CI runner), so
    # the dex is appended with Python. aapt2 already wrote the assets, so this
    # must add to the archive rather than repack it.
    unsigned2 = os.path.join(BUILD, 'unsigned2.apk')
    shutil.copy(apk_unsigned, unsigned2)
    with zipfile.ZipFile(unsigned2, 'a', zipfile.ZIP_DEFLATED) as z:
        z.write(dex, 'classes.dex')

    print('== zipalign ==')
    aligned = os.path.join(BUILD, 'aligned.apk')
    run([os.path.join(BT, 'zipalign'), '-f', '-p', '4',
         os.path.join(BUILD, 'unsigned2.apk'), aligned])

    # ------------------------------------------------------------ sign
    print('== sign ==')
    ks = os.path.join(ROOT, 'android-keystore.jks')
    if not os.path.exists(ks):
        run(['keytool', '-genkeypair', '-keystore', ks, '-alias', 'texpark',
             '-keyalg', 'RSA', '-keysize', '2048', '-validity', '10950',
             '-storepass', 'texpark', '-keypass', 'texpark',
             '-dname', 'CN=Texpark Pro, O=TEXPARK BUYING HOUSE, C=BD'])
    run([os.path.join(BT, 'apksigner'), 'sign',
         '--ks', ks, '--ks-key-alias', 'texpark',
         '--ks-pass', 'pass:texpark', '--key-pass', 'pass:texpark',
         '--out', OUT, aligned])
    print('== verify ==')
    print(run([os.path.join(BT, 'apksigner'), 'verify', '--print-certs', OUT]))

    # An APK that verifies but carries no app is the failure worth catching here:
    # it installs cleanly and opens to a blank page.
    with zipfile.ZipFile(OUT) as z:
        names = z.namelist()
        need = ['assets/site/index.html', 'assets/site/version.txt',
                'assets/site/js/app.js',
                'assets/site/js/db.js', 'assets/site/css/app.css', 'classes.dex']
        missing = [n for n in need if n not in names]
        if missing:
            raise SystemExit('APK is missing: ' + ', '.join(missing))
        bundled = z.read('assets/site/version.txt').decode('utf-8').strip()
        if bundled != version:
            raise SystemExit('APK holds %r but the deploy folder is %r' % (bundled, version))
        appjs = z.read('assets/site/js/app.js').decode('utf-8')
        if ("APP_VERSION = '" + version + "'") not in appjs:
            raise SystemExit('bundled app.js does not claim version ' + version)
    print('verified: app %s wrapped inside, dex present, %d files' % (version, len(names)))
    print('built', OUT, round(os.path.getsize(OUT) / 1024), 'KB')


if __name__ == '__main__':
    main()