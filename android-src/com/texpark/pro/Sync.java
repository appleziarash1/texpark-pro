package com.texpark.pro;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Cloud backup and pull against the same Google Apps Script as the web app.
 *
 * The sheet is addressed by the same payload shapes the web version used, so one
 * spreadsheet serves both - the PC on the web app and the phone on this one write
 * to the same rows. A backup is keyed by device tag and the sheet upserts on it,
 * so repeated backups replace rather than pile up.
 *
 * Every call reports what actually happened: a network failure must not be
 * reported as a successful sync, because the owner would then stop worrying about
 * a backup that never happened.
 */
public final class Sync {

    private static final int CONNECT_MS = 15000;
    private static final int READ_MS = 25000;

    /** The app's version, handed in by the activity at startup.
     *
     *  Read from a field rather than straight out of MainActivity so this whole
     *  class compiles and runs on a plain JVM - the rules about what counts as a
     *  successful sync are the ones that quietly lose the owner's work, so they
     *  are worth testing without a phone. */
    public static String appVersion = "";

    /** How long before an automatic poll may run again. Opening several screens in
     *  a row is normal; without this each one would fetch the sheet. */
    public static final long POLL_EVERY_MS = 30000L;

    private Sync() {}

    /* --------------------------------------------------- decisions (pure) */

    /** Whether an automatic poll is due. Kept separate from the HTTP around it so
     *  the "too soon" rule can be tested with a made-up clock. */
    public static boolean pollDue(long lastPollMs, long nowMs) {
        if (lastPollMs <= 0L) return true;
        return nowMs - lastPollMs >= POLL_EVERY_MS;
    }

    /** The sheet's own verdict on an upload.
     *
     *  Apps Script answers 200 whether it saved or refused, and a proxy or a login
     *  page can answer 200 with HTML. Reading the body is the only truthful check:
     *  anything that is not a JSON object with success not-false is a failure, and
     *  calling it a success is how a memo that never left the phone gets believed. */
    public static boolean pushAccepted(String reply) {
        if (reply == null || reply.trim().isEmpty()) return false;
        try {
            Map<String, Object> j = Json.obj(Json.read(reply));
            if (j.isEmpty()) return false;
            return !Boolean.FALSE.equals(j.get("success"));
        } catch (Exception e) {
            return false;
        }
    }

    /** The per-device reassembly errors a pullall reply may carry, as one sentence.
     *
     *  A backup that could not be rebuilt from its chunks (a half-written set) is
     *  reported by the server in an `errors` map rather than silently omitted. It is
     *  pulled out here so the owner sees which device's books did not arrive - a
     *  device missing from a merge with no word said is data that looks synced and
     *  is not. Returns "" when there is nothing to report. */
    public static String pullErrors(String reply) {
        try {
            Map<String, Object> root = Json.obj(Json.read(reply));
            Map<String, Object> errs = Json.obj(root.get("errors"));
            StringBuilder b = new StringBuilder();
            for (Map.Entry<String, Object> e : errs.entrySet()) {
                if (b.length() > 0) b.append("; ");
                b.append(e.getKey()).append(": ").append(String.valueOf(e.getValue()));
            }
            return b.toString();
        } catch (Exception e) {
            return "";
        }
    }

    /** What to tell the owner after an upload attempt. */
    public static String pushReport(boolean accepted, String reply, String device) {
        if (accepted) return "Cloud backup sent (" + device + ").";
        String err = errorOf(reply);
        if (err != null) return "The sheet said: " + err;
        return "Could not send the cloud backup \u2014 check the internet and the URL.";
    }

    /** What to tell the owner after a pull-and-merge.
     *
     *  The push is reported separately and first, because a merge that succeeded
     *  while the upload failed is exactly the case that used to be reported as
     *  "synced": this device learned the cloud's news and the cloud never learned
     *  this device's. A device whose backup could not be reassembled is named too:
     *  its books stayed invisible, which is silence the owner must not mistake for
     *  "nothing new". */
    public static String mergeReport(boolean pushOk, int merged, boolean committed, String saveError) {
        return mergeReport(pushOk, merged, committed, saveError, null);
    }

    public static String mergeReport(boolean pushOk, int merged, boolean committed, String saveError,
                                     String pullErrors) {
        StringBuilder b = new StringBuilder();
        if (!pushOk) {
            b.append("This device's data did not reach the sheet \u2014 it will retry.")
             .append(" (Check the internet and the URL.)");
        }
        if (pullErrors != null && !pullErrors.isEmpty()) {
            b.append(b.length() > 0 ? "\n" : "")
             .append("Some backups could not be read: ").append(pullErrors);
        }
        if (!committed) {
            b.append(b.length() > 0 ? "\n" : "")
             .append("Could not save the merge")
             .append(saveError == null || saveError.isEmpty() ? "." : ": " + saveError);
            return b.toString();
        }
        if (merged == 0) {
            b.append(b.length() > 0 ? "\n" : "")
             .append("No new backup in the sheet.");
            return b.toString();
        }
        b.append(b.length() > 0 ? "\n" : "")
         .append(merged).append(" snapshot(s) merged.");
        return b.toString();
    }

    /* ------------------------------------------------------------ public API */

    /** Sends this device's whole database up. Returns a sentence for the owner. */
    public static String backup(Store store, String url) {
        if (url == null || url.trim().isEmpty()) return "Set the sync URL in Settings first.";
        Map<String, Object> data = new LinkedHashMap<String, Object>();
        data.put("device", store.deviceTag());
        data.put("date", Store.today());
        data.put("version", appVersion);
        data.put("json", store.snapshotJson());

        Map<String, Object> payload = new LinkedHashMap<String, Object>();
        payload.put("type", "backup");
        payload.put("data", data);
        String body = Json.write(payload);

        String trimmed = trimSlash(url);
        String res = post(trimmed, body);
        return pushReport(pushAccepted(res), res, store.deviceTag());
    }

    /** A push that only says whether it worked, for callers that act on it. */
    public static boolean backupQuiet(Store store, String url) {
        if (url == null || url.trim().isEmpty()) return false;
        Map<String, Object> data = new LinkedHashMap<String, Object>();
        data.put("device", store.deviceTag());
        data.put("date", Store.today());
        data.put("version", appVersion);
        data.put("json", store.snapshotJson());
        Map<String, Object> payload = new LinkedHashMap<String, Object>();
        payload.put("type", "backup");
        payload.put("data", data);
        return pushAccepted(post(trimSlash(url), Json.write(payload)));
    }

    /** Pushes, then pulls and merges: the direction that cannot lose this device's work. */
    public static String pullAll(Store store, String url) {
        String trimmed = trimSlash(url);
        if (trimmed.isEmpty()) return "Set the sync URL in Settings first.";

        // Push first. If this device's work only exists locally, merging a pull over
        // the top of it would lose it; sending it up first makes the cloud a superset.
        // Whether it really went up is remembered, not discarded: a pull that merges
        // while this device's own work failed to upload must not be reported as a
        // clean sync - the other machines would never see the new memo.
        boolean pushed = backupQuiet(store, trimmed);

        String res = get(trimmed + "?action=pullall");
        if (res == null) return mergeReport(pushed, 0, true, null);
        String err = errorOf(res);
        if (err != null) return "The sheet said: " + err;

        Object parsed = Json.read(res);
        Map<String, Object> root = Json.obj(parsed);
        String pullErrors = pullErrors(res);
        /* ?action=pullall answers with one JSON object per device, keyed by tag,
           rather than a list: one round trip is one moment in time, so two
           snapshots cannot be read either side of a write and merged as if they
           agreed. Older builds answered with a list, so both shapes are read. */
        Map<String, Object> byDevice = Json.obj(root.get("json"));
        List<Object> rows = Json.arr(root.get("rows"));
        if (!rows.isEmpty()) {
            for (Object o : rows) {
                Map<String, Object> row = Store.rec(o);
                if (!Store.str(row, "json").isEmpty()) byDevice.put(Store.str(row, "device"), row.get("json"));
            }
        }
        if (byDevice.isEmpty() && root.get("json") instanceof String) {
            String only = Store.str(root, "json");
            if (!only.isEmpty()) byDevice.put(store.deviceTag(), only);
        }

        int merged = 0;
        for (Map.Entry<String, Object> e : byDevice.entrySet()) {
            String json = e.getValue() instanceof String ? (String) e.getValue() : "";
            if (json.isEmpty()) continue;
            Object incoming = Json.read(json);
            if (!(incoming instanceof Map)) continue;
            store.mergeCloudInto(Store.cast(incoming));
            merged++;
        }
        if (merged == 0) return mergeReport(pushed, 0, true, null, pullErrors);
        boolean committed = store.commit();
        return mergeReport(pushed, merged, committed, store.lastSaveError, pullErrors);
    }

    /** A single-device pull, used to repair one machine from the sheet. */
    public static String pullDevice(Store store, String url, String device) {
        String trimmed = trimSlash(url);
        if (trimmed.isEmpty()) return "Set the sync URL in Settings first.";
        String res = get(trimmed + "?action=pull&device=" + enc(device));
        if (res == null) return "Could not fetch from the sheet.";
        String err = errorOf(res);
        if (err != null) return "The sheet said: " + err;
        Map<String, Object> root = Json.obj(Json.read(res));
        String json = Store.str(root, "json");
        if (json.isEmpty()) return "The sheet has no backup for \"" + device + "\".";
        Object incoming = Json.read(json);
        if (!(incoming instanceof Map)) return "The backup is not valid.";
        store.mergeCloudInto(Store.cast(incoming));
        if (!store.commit()) {
            return "Could not save the restore"
                    + (store.lastSaveError == null ? "." : ": " + store.lastSaveError);
        }
        return "Restored.";
    }

    /** A quick reachability test, with the same honesty about failure. */
    public static String push(Store store, String url) { return backup(store, url); }

    /* ------------------------------------------------------------ plumbing */

    /**
     * Reads the success flag rather than trusting the HTTP status: Apps Script
     * answers 200 with a body that says success:false, so a status check alone
     * would call a failed write a success.
     */
    private static String errorOf(String body) {
        try {
            Map<String, Object> j = Json.obj(Json.read(body));
            if (Boolean.FALSE.equals(j.get("success"))) {
                String m = Store.str(j, "message");
                return m.isEmpty() ? "unknown error" : m;
            }
        } catch (Exception ignored) { }
        return null;
    }

    private static String trimSlash(String s) {
        String out = s == null ? "" : s.trim();
        while (out.endsWith("/")) out = out.substring(0, out.length() - 1);
        return out;
    }

    private static String enc(String s) {
        try { return URLEncoder.encode(s == null ? "" : s, "UTF-8"); }
        catch (Exception e) { return ""; }
    }

    private static String post(String base, String body) {
        HttpURLConnection c = null;
        try {
            c = (HttpURLConnection) new URL(base).openConnection();
            c.setConnectTimeout(CONNECT_MS);
            c.setReadTimeout(READ_MS);
            c.setRequestMethod("POST");
            c.setDoOutput(true);
            c.setUseCaches(false);
            c.setRequestProperty("Content-Type", "text/plain;charset=utf-8");
            OutputStream out = c.getOutputStream();
            try {
                out.write(body.getBytes("UTF-8"));
                out.flush();
            } finally {
                out.close();
            }
            return read(c);
        } catch (Exception e) {
            return null;
        } finally {
            if (c != null) c.disconnect();
        }
    }

    private static String get(String url) {
        HttpURLConnection c = null;
        try {
            c = (HttpURLConnection) new URL(url).openConnection();
            c.setConnectTimeout(CONNECT_MS);
            c.setReadTimeout(READ_MS);
            c.setUseCaches(false);
            c.setRequestProperty("Cache-Control", "no-cache");
            return read(c);
        } catch (Exception e) {
            return null;
        } finally {
            if (c != null) c.disconnect();
        }
    }

    private static String read(HttpURLConnection c) throws Exception {
        int code = c.getResponseCode();
        InputStream in = code >= 400 ? c.getErrorStream() : c.getInputStream();
        if (in == null) return null;
        ByteArrayOutputStream buf = new ByteArrayOutputStream();
        byte[] chunk = new byte[8192];
        int n;
        while ((n = in.read(chunk)) > 0) buf.write(chunk, 0, n);
        in.close();
        return new String(buf.toByteArray(), "UTF-8");
    }
}
