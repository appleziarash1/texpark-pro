package com.texpark.pro;

import android.content.Context;
import android.content.res.AssetManager;
import android.util.Log;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;

/**
 * Puts the app on internal storage so the WebView always has real files to read
 * and the app still opens with no internet.
 *
 * Two copies can exist:
 *   built-in  - the build wrapped inside the APK, under assets/site/
 *   updated   - a newer build downloaded from the hosted site after install
 *
 * The owner's rule is that the app must work offline, so an update is only ever
 * a bonus: it arrives in the background and is swapped in whole. The decisions
 * live in {@link Updater}, where they can be tested without a device; this
 * class is only the Android plumbing around them.
 */
public final class AppInstaller {

    private static final String TAG = "TexparkInstaller";
    private static final String SITE_DIR = "site";
    private static final int CONNECT_TIMEOUT_MS = 15000;
    private static final int READ_TIMEOUT_MS = 20000;

    private AppInstaller() {
    }

    /** Where the WebView loads from: the updated copy if there is one, else the APK's. */
    public static File siteDir(Context ctx) {
        return new File(ctx.getFilesDir(), SITE_DIR);
    }

    /** The version of the copy the WebView will actually load, or "" when unreadable. */
    public static String installedVersion(Context ctx) {
        return Updater.versionOf(siteDir(ctx));
    }

    /**
     * Unpacks assets/site on first launch, and again after an APK install that
     * carries a newer build than whatever is already on disk.
     */
    public static void installBundledIfNeeded(Context ctx) {
        String bundled = readAsset(ctx, SITE_DIR + "/version.txt");
        if (bundled == null) {
            Log.e(TAG, "the APK has no bundled app to install");
            return;
        }
        if (Updater.shouldInstallBundled(bundled, installedVersion(ctx))) {
            File dir = siteDir(ctx);
            Updater.deleteTree(dir);
            copyBundled(ctx, dir);
            Log.i(TAG, "bundled app installed at " + bundled.trim());
        }
    }

    /** Throws away a downloaded build and reinstalls the one inside the APK. */
    public static void resetToBundled(Context ctx) {
        File dir = siteDir(ctx);
        Updater.deleteTree(dir);
        Updater.deleteTree(new File(dir.getAbsolutePath() + ".old"));
        Updater.deleteTree(new File(dir.getAbsolutePath() + ".new"));
        copyBundled(ctx, dir);
    }

    private static void copyBundled(Context ctx, File dir) {
        try {
            copyAssets(ctx, SITE_DIR, dir);
        } catch (IOException e) {
            Log.e(TAG, "could not install bundled app", e);
        }
    }

    /** Downloads a newer build when the host has one, and swaps it in. */
    public static boolean downloadUpdate(Context ctx, String baseUrl) {
        String root = trimSlash(baseUrl);
        if (root.isEmpty()) return false;
        return Updater.applyUpdate(siteDir(ctx), installedVersion(ctx), new Net(root));
    }

    /** Fetches build files over HTTP; the one piece {@link Updater} cannot own. */
    private static final class Net implements Updater.Fetcher {
        private final String root;

        Net(String root) {
            this.root = root;
        }

        public byte[] get(String path) {
            return downloadBytes(root + "/" + path);
        }
    }

    // ------------------------------------------------------------------ files

    private static String trimSlash(String s) {
        String out = s == null ? "" : s.trim();
        while (out.endsWith("/")) out = out.substring(0, out.length() - 1);
        return out;
    }

    private static void copyAssets(Context ctx, String from, File to) throws IOException {
        AssetManager am = ctx.getAssets();
        String[] children = am.list(from);
        if (children == null || children.length == 0) {
            byte[] bytes = readAssetBytes(ctx, from);
            if (bytes != null) writeFileAt(to, bytes);
            return;
        }
        if (!to.exists() && !to.mkdirs()) throw new IOException("mkdirs " + to);
        for (String child : children) copyAssets(ctx, from + "/" + child, new File(to, child));
    }

    private static byte[] readAssetBytes(Context ctx, String path) {
        InputStream in = null;
        try {
            in = ctx.getAssets().open(path);
            return Updater.readAll(in);
        } catch (IOException e) {
            return null;
        } finally {
            close(in);
        }
    }

    private static String readAsset(Context ctx, String path) {
        byte[] bytes = readAssetBytes(ctx, path);
        if (bytes == null) return null;
        return new String(bytes, java.nio.charset.Charset.forName("UTF-8"));
    }

    private static void writeFileAt(File f, byte[] bytes) throws IOException {
        File parent = f.getParentFile();
        if (parent != null && !parent.exists() && !parent.mkdirs()) {
            throw new IOException("mkdirs " + parent);
        }
        FileOutputStream out = new FileOutputStream(f);
        try {
            out.write(bytes);
        } finally {
            close(out);
        }
    }

    private static void close(java.io.Closeable c) {
        if (c != null) try {
            c.close();
        } catch (IOException ignored) {
        }
    }

    /**
     * Caching is off on purpose: a cached version.txt would keep the phone
     * pinned to the old build no matter how many times it checked.
     */
    private static byte[] downloadBytes(String url) {
        HttpURLConnection c = null;
        try {
            c = (HttpURLConnection) new URL(url).openConnection();
            c.setConnectTimeout(CONNECT_TIMEOUT_MS);
            c.setReadTimeout(READ_TIMEOUT_MS);
            c.setUseCaches(false);
            c.setRequestProperty("Cache-Control", "no-cache");
            c.setRequestProperty("Pragma", "no-cache");
            if (c.getResponseCode() != 200) return null;
            InputStream in = c.getInputStream();
            try {
                return Updater.readAll(in);
            } finally {
                close(in);
            }
        } catch (Exception e) {
            return null;
        } finally {
            if (c != null) c.disconnect();
        }
    }
}
