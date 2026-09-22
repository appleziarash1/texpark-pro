import zipfile, os
root = '/workspace/project'
src = os.path.join(root, 'texpark-deploy')
out = os.path.join(root, 'texpark-pro-download.zip')
if os.path.exists(out):
    os.remove(out)
z = zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED)

def add(path, arc):
    if os.path.isdir(path):
        for r, d, files in os.walk(path):
            for f in files:
                add(os.path.join(r, f), os.path.join(arc, os.path.relpath(os.path.join(r, f), path)))
    else:
        z.write(path, arc)

# the whole hostable app folder, with the friendly launcher inside it
add(src, 'texpark-pro-app')
for extra in ['OPEN_APP.bat', 'START_APP.bat', 'CREATE_DESKTOP_SHORTCUT.bat', 'main.js', 'package.json']:
    p = os.path.join(root, 'texpark-pro', extra)
    if os.path.exists(p):
        z.write(p, 'texpark-pro-app/' + extra)
# the single file for the phone, and the offline catalog
z.write(os.path.join(root, 'texpark-pro.html'), 'texpark-pro.html')
z.write(os.path.join(root, 'catalog', 'catalog-pro-v1.html'), 'catalog-pro-v1.html')
# the Android app and its install guide
z.write(os.path.join(root, 'TexparkPro.apk'), 'TexparkPro.apk')
z.write(os.path.join(root, 'ANDROID_BANGLA.txt'), 'ANDROID_BANGLA.txt')
z.close()

names = zipfile.ZipFile(out).namelist()
for n in sorted(names):
    print(' ', n)
print('total', len(names), 'files,', round(os.path.getsize(out) / 1024), 'KB')
