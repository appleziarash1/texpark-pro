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
z.writestr('_redirects', '/*    /index.html   200\n')
z.close()

names = sorted(zipfile.ZipFile(out).namelist())
for n in names:
    print(' ', n)
assert 'index.html' in names, 'index.html must sit at the archive root'
print('OK: index.html is at the top level')
print('total', len(names), 'files,', round(os.path.getsize(out) / 1024), 'KB')
