import zipfile, os
root = '/workspace/project'
src = os.path.join(root, 'texpark-deploy')
out = os.path.join(root, 'texpark-hosting.zip')
if os.path.exists(out):
    os.remove(out)
z = zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED)

# Hosting needs index.html at the TOP LEVEL of the archive. If the folder is
# nested (texpark-pro-app/index.html) the host serves 404 at "/", which is the
# mistake this separate, flat zip exists to prevent.
for r, d, files in os.walk(src):
    for f in files:
        full = os.path.join(r, f)
        arc = os.path.relpath(full, src)
        if arc == 'HOSTING_BANGLA.txt':
            continue
        z.write(full, arc)
# No catch-all rewrite is written on purpose. "/* /index.html 200" looks
# harmless, but Netlify would then answer every unknown path with the app HTML.
# A single missing file in a deploy would be served as a valid-looking page
# instead of a 404, so a half-uploaded release would look complete and the
# installer could save markup under a .js name. Netlify already serves
# index.html at "/", so the fallback buys nothing worth that risk.
z.close()

# The APK is not added here: build.js already copies it into texpark-deploy, so
# this walk picks it up with everything else. Adding it again would put two
# copies of the same file in the archive.
names = sorted(zipfile.ZipFile(out).namelist())
for n in names:
    print(' ', n)
assert 'index.html' in names, 'index.html must sit at the archive root'
assert 'js/app.js' in names, 'the phone reads its version out of js/app.js'
assert 'TexparkPro.apk' in names, 'the APK must ship so the site can offer it'
assert '_redirects' not in names, 'a catch-all redirect would hide missing files'
print('OK: index.html is at the top level')
print('total', len(names), 'files,', round(os.path.getsize(out) / 1024), 'KB')

