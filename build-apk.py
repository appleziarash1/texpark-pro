#!/usr/bin/env python3
"""Builds Texpark Pro.apk (Android) from android-src/.

A WebView shell around the web app, NOT a copy of it. On first launch the user
enters the Netlify address he already has; the WebView loads that address, so
the phone always runs whatever the host currently serves. Fix the web app once,
upload it, and every installed APK shows the fix with no new APK.

Runs on JDK + Android SDK build-tools only, so there is no Gradle download.
"""
import os
import shutil
import struct
import subprocess
import sys
import zlib

ROOT = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(ROOT, 'android-src')
BUILD = os.path.join(ROOT, 'android-build')
SDK = os.environ.get('ANDROID_HOME', '/opt/android-sdk')
PLATFORM = os.path.join(SDK, 'platforms', 'android-34', 'android.jar')


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
VERSION_CODE = 1
VERSION_NAME = '1.0.0'
MIN_SDK = 21
TARGET_SDK = 34


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
    if os.path.exists(BUILD):
        shutil.rmtree(BUILD)
    for d in ['res', 'gen', 'obj', 'classes', 'dex', 'apk']:
        os.makedirs(os.path.join(BUILD, d), exist_ok=True)
    res, gen, obj = (os.path.join(BUILD, d) for d in ('res', 'gen', 'obj'))

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
         '--java', gen,
         '--min-sdk-version', str(MIN_SDK),
         '--target-sdk-version', str(TARGET_SDK),
         '--version-code', str(VERSION_CODE),
         '--version-name', VERSION_NAME,
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
    shutil.copy(apk_unsigned, os.path.join(BUILD, 'unsigned2.apk'))
    run(['zip', '-j', '-q', os.path.join(BUILD, 'unsigned2.apk'), dex])

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
    print('built', OUT, round(os.path.getsize(OUT) / 1024), 'KB')


if __name__ == '__main__':
    main()