package com.texpark.pro;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * The part of updating that has nothing to do with Android.
 *
 * Kept free of Android types so it can be compiled and run on a plain JVM. The
 * rules here decide whether a phone takes a new build at all, and getting one
 * wrong means the owner sits on a version with a bug he already reported,
 * permanently and silently - so it is worth testing without a device.
 *
 * Nothing here trusts a file merely because it answered 200. Hosts are commonly
 * configured to answer every unknown path with index.html, so a request for
 * version.txt can come back as a page of HTML. The version and the file list
 * are therefore read out of files that are certainly real - the app's own
 * script and markup - and any HTML in a build file is treated as that fallback.
 */
public final class Updater {

    private Updater() {
    }

    /** Supplies the bytes for one path of a remote build. */
    public interface Fetcher {
        byte[] get(String path);
    }

    /** The app script, which is the source of truth for a build's version. */
    static final String VERSION_FILE = "js/app.js";
    /** The app's markup, which is walked for the list of files a build needs. */
    static final String INDEX_FILE = "index.html";

    private static final Pattern VERSION_DECL =
            Pattern.compile("APP_VERSION\\s*=\\s*'([^']+)'");

    /**
     * Version reported by a copy of js/app.js, or "" when it carries none.
     *
     * app.js is used rather than a version.txt of our own because it is the one
     * file the app genuinely needs: no host fallback can fake it, and it is the
     * same number the running app shows, so the two can never disagree.
     */
    public static String versionIn(String appJs) {
        if (appJs == null) return "";
        Matcher m = VERSION_DECL.matcher(appJs);
        return m.find() ? m.group(1).trim() : "";
    }

    /**
     * Whether bytes fetched for a build file are really that file.
     *
     * A host told to answer unknown paths with index.html returns 200 and HTML
     * for anything missing. Reading that as a script or a version would either
     * corrupt the app or make it decide it is up to date forever, so HTML is
     * always refused here and the phone keeps running what it has.
     */
    public static boolean looksLikeBuildFile(byte[] bytes) {
        if (bytes == null || bytes.length == 0) return false;
        String head = new String(bytes, 0, Math.min(bytes.length, 512),
                java.nio.charset.Charset.forName("UTF-8"));
        String low = head.toLowerCase();
        return !(low.contains("<!doctype") || low.contains("<html")
                || low.contains("texpark-build-root"));
    }

    /**
     * Relative paths index.html asks the browser for.
     *
     * Derived from the markup rather than shipped as a hand-kept list, because a
     * list is one more thing that can fall out of step with the app. Absolute
     * URLs, data URIs and in-page anchors are not files of this build, so they
     * are skipped.
     */
    public static List<String> referencedFiles(String html) {
        Set<String> out = new LinkedHashSet<String>();
        if (html == null) return new ArrayList<String>(out);
        Matcher m = Pattern.compile("(?:href|src)\\s*=\\s*\"([^\"]+)\"").matcher(html);
        while (m.find()) {
            String ref = m.group(1).trim();
            if (ref.startsWith("http://") || ref.startsWith("https://")
                    || ref.startsWith("data:") || ref.startsWith("#")
                    || ref.startsWith("mailto:")) continue;
            ref = ref.split("\\?")[0].split("#")[0];
            if (ref.isEmpty()) continue;
            if (ref.startsWith("/") || ref.contains("..")) continue;
            out.add(ref);
        }
        return new ArrayList<String>(out);
    }

    /** The version of a build sitting on disk, or "" when unreadable. */
    public static String versionOf(File dir) {
        if (dir == null) return "";
        File f = new File(dir, VERSION_FILE);
        if (!f.isFile()) return "";
        try {
            InputStream in = new java.io.FileInputStream(f);
            try {
                return versionIn(new String(readAll(in), "UTF-8"));
            } finally {
                in.close();
            }
        } catch (IOException e) {
            return "";
        }
    }

    /**
     * Whether the build inside the APK should replace what is on disk.
     *
     * This runs after both a first install and an APK upgrade. On a first
     * install there is nothing to compare; on an upgrade the APK's build is
     * newer than a download the phone took earlier, and that stale download
     * would otherwise hide the fresh app forever.
     */
    public static boolean shouldInstallBundled(String bundledVersion, String installedVersion) {
        if (bundledVersion == null || bundledVersion.trim().isEmpty()) return false;
        return compareVersions(bundledVersion, installedVersion) > 0;
    }

    /**
     * Fetches a newer build from {@code f} and installs it over {@code dest},
     * returning whether anything was installed.
     *
     * The build is fetched whole into a staging folder first. A build whose
     * every listed file arrived is then swapped in with two renames, so a phone
     * killed mid-check is left either fully on the old build or fully on the
     * new one - never half of each.
     */
    public static boolean applyUpdate(File dest, String currentVersion, Fetcher f) {
        try {
            byte[] jsBytes = f.get(VERSION_FILE);
            if (!looksLikeBuildFile(jsBytes)) return false;
            String remote = versionIn(new String(jsBytes, "UTF-8"));
            if (remote.isEmpty()) return false;
            if (compareVersions(remote, currentVersion) <= 0) return false;

            byte[] htmlBytes = f.get(INDEX_FILE);
            if (htmlBytes == null || htmlBytes.length == 0) return false;
            String html = new String(htmlBytes, "UTF-8");
            // index.html is genuinely a page, so it is the one file that cannot
            // be checked for HTML. It is the page only if it still names the
            // app script the rest of this check depends on.
            if (!html.contains(VERSION_FILE)) return false;
            // index.html does not reference itself, yet it is the one file the
            // build cannot start without, so it leads the list.
            List<String> files = new ArrayList<String>();
            files.add(INDEX_FILE);
            files.addAll(referencedFiles(html));
            if (files.size() < 2) return false;

            File staging = new File(dest.getAbsolutePath() + ".new");
            deleteTree(staging);
            if (!staging.mkdirs()) return false;

            for (String rel : files) {
                byte[] bytes = rel.equals(INDEX_FILE) ? htmlBytes : f.get(rel);
                // A missing asset answered with the app page must not be saved
                // under its own name: a .js full of markup breaks the app after
                // the update instead of before it.
                if (rel.equals(INDEX_FILE) ? bytes == null : !looksLikeBuildFile(bytes)) {
                    deleteTree(staging);
                    return false;
                }
                writeFileAt(new File(staging, rel), bytes);
            }

            File old = new File(dest.getAbsolutePath() + ".old");
            deleteTree(old);
            if (dest.exists() && !dest.renameTo(old)) {
                deleteTree(staging);
                return false;
            }
            if (!staging.renameTo(dest)) {
                deleteTree(staging);
                if (old.exists()) old.renameTo(dest);
                return false;
            }
            deleteTree(old);
            return true;
        } catch (Exception e) {
            return false;
        }
    }

    /**
     * Whether the host is offering an APK newer than the one installed.
     *
     * The version is read out of js/app.js, never out of version.txt. A host
     * configured with a catch-all rewrite answers any unknown path - version.txt
     * included - with index.html, so a stamp read from there can be a page of
     * HTML, compare as not-newer, and leave the phone on its old build forever
     * with nothing on screen saying why. js/app.js is a file the app genuinely
     * needs, so no fallback can fake it, and it is the same number the running
     * app shows.
     *
     * A downloaded APK is never installed silently. Since Android 8 an app may not
     * install an APK from its own process - only the system installer may, after
     * the owner confirms - so a silent self-update would be a lie in the code. The
     * owner is pointed at the file and installs it, and his data survives because
     * it lives in the app's data folder, not in the APK.
     *
     * False on any failure (offline, a host that is down, a malformed stamp): a
     * check that cannot reach the host must never be reported as "up to date".
     */
    public static boolean hasNewerRelease(String baseUrl, String currentVersion) {
        return compareVersions(releaseVersionAt(baseUrl), currentVersion) > 0;
    }

    /**
     * The version a host is publishing, or "" when it is not publishing one.
     *
     * Nothing here trusts a file merely because it answered 200: the bytes have
     * to look like the app script, not like a page a fallback rewrite handed out.
     */
    public static String releaseVersionAt(String baseUrl) {
        String root = trimSlash(baseUrl);
        if (root.isEmpty()) return "";
        java.net.HttpURLConnection c = null;
        try {
            c = (java.net.HttpURLConnection) new java.net.URL(root + "/" + VERSION_FILE).openConnection();
            c.setConnectTimeout(8000);
            c.setReadTimeout(8000);
            c.setUseCaches(false);
            c.setRequestProperty("Cache-Control", "no-cache");
            if (c.getResponseCode() != 200) return "";
            java.io.InputStream in = c.getInputStream();
            byte[] bytes;
            try {
                bytes = readAll(in);
            } finally {
                in.close();
            }
            if (!looksLikeBuildFile(bytes)) return "";
            return versionIn(new String(bytes, "UTF-8"));
        } catch (Exception e) {
            return "";
        } finally {
            if (c != null) c.disconnect();
        }
    }

    private static String trimSlash(String s) {
        String out = s == null ? "" : s.trim();
        while (out.endsWith("/")) out = out.substring(0, out.length() - 1);
        return out;
    }

    /**
     * Compares version strings by their numeric parts, so 2026-09-22.10 sorts
     * above 2026-09-22.9. A plain string compare gets that backwards, and the
     * phone would never take the tenth fix of a day.
     */
    public static int compareVersions(String a, String b) {
        int[] x = versionParts(a), y = versionParts(b);
        for (int i = 0; i < Math.max(x.length, y.length); i++) {
            int xi = i < x.length ? x[i] : 0;
            int yi = i < y.length ? y[i] : 0;
            if (xi != yi) return xi < yi ? -1 : 1;
        }
        return 0;
    }

    private static int[] versionParts(String v) {
        String[] bits = (v == null ? "" : v.trim()).split("[^0-9]+");
        int n = 0;
        for (String bit : bits) if (bit.length() > 0) n++;
        int[] out = new int[n];
        int i = 0;
        for (String bit : bits) {
            if (bit.length() == 0) continue;
            try {
                out[i++] = Integer.parseInt(bit);
            } catch (NumberFormatException e) {
                out[i++] = 0;
            }
        }
        return out;
    }

    // ------------------------------------------------------------------ files

    static void writeFileAt(File f, byte[] bytes) throws IOException {
        File parent = f.getParentFile();
        if (parent != null && !parent.exists() && !parent.mkdirs()) {
            throw new IOException("mkdirs " + parent);
        }
        FileOutputStream out = new FileOutputStream(f);
        try {
            out.write(bytes);
        } finally {
            out.close();
        }
    }

    static void deleteTree(File f) {
        if (f == null || !f.exists()) return;
        if (f.isDirectory()) {
            File[] kids = f.listFiles();
            if (kids != null) for (File k : kids) deleteTree(k);
        }
        f.delete();
    }

    static byte[] readAll(InputStream in) throws IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buf = new byte[8192];
        int n;
        while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
        return out.toByteArray();
    }
}
