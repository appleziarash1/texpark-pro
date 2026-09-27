package com.texpark.pro;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.DialogInterface;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.text.InputType;
import android.util.Log;
import android.util.TypedValue;
import android.view.KeyEvent;
import android.view.View;
import android.webkit.JavascriptInterface;
import android.webkit.PermissionRequest;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;

import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.URLConnection;
import java.util.HashMap;
import java.util.Map;

/**
 * Texpark Pro on Android.
 *
 * The app itself is wrapped inside the APK, so it opens instantly, works with
 * no internet at all, and never shows a blank page because a host is down.
 * The hosted site has one job: offering a newer build, which is downloaded in
 * the background and used from the next launch onward.
 *
 * Files reach the WebView through {@link #shouldInterceptRequest} under a
 * made-up https origin rather than as file:// URLs. That detail is load-bearing:
 * a file:// page has an opaque origin where localStorage is blocked, and every
 * memo, stock card and setting lives in localStorage. The app would open, look
 * right, and forget everything when closed.
 */
public class MainActivity extends Activity {

    private static final String TAG = "TexparkPro";

    /** Not a real domain: requests for it are answered from the app's own folder. */
    private static final String HOST = "app.texpark.local";
    private static final String START_URL = "https://" + HOST + "/index.html";

    private static final String PREFS = "texpark";
    private static final String KEY_URL = "site_url";
    /** Where newer builds come from. Changeable from the long-press Back menu. */
    private static final String DEFAULT_UPDATE_URL = "https://appleziarash1.github.io/texpark-pro";

    private static final int REQ_FILE = 1001;

    private WebView web;
    private ValueCallback<Uri[]> fileCallback;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        if (Build.VERSION.SDK_INT >= 21) {
            getWindow().addFlags(android.view.WindowManager.LayoutParams.FLAG_DRAWS_SYSTEM_BAR_BACKGROUNDS);
            getWindow().setStatusBarColor(Color.parseColor("#12366b"));
        }
        AppInstaller.installBundledIfNeeded(this);
        showApp();
        checkForUpdateInBackground(false);
    }

    // ------------------------------------------------------------------ webview

    private void showApp() {
        web = new WebView(this);
        web.setBackgroundColor(Color.WHITE);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setLoadWithOverviewMode(true);
        s.setUseWideViewPort(true);
        s.setBuiltInZoomControls(false);
        s.setDisplayZoomControls(false);
        s.setSupportZoom(false);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);

        web.addJavascriptInterface(new Bridge(), "AndroidBridge");

        web.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView v, WebResourceRequest req) {
                return serveLocal(req.getUrl().getHost(), req.getUrl().getPath());
            }

            @Override
            @SuppressWarnings("deprecation")
            public WebResourceResponse shouldInterceptRequest(WebView v, String url) {
                Uri u = Uri.parse(url);
                return serveLocal(u.getHost(), u.getPath());
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest r) {
                return openOutside(r.getUrl());
            }

            @Override
            @SuppressWarnings("deprecation")
            public boolean shouldOverrideUrlLoading(WebView v, String u) {
                return openOutside(Uri.parse(u));
            }
        });

        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onPermissionRequest(final PermissionRequest request) {
                runOnUiThread(new Runnable() {
                    public void run() {
                        request.grant(request.getResources());
                    }
                });
            }

            /**
             * Backup restore picks a .json off the phone through a file input.
             * Without this the button quietly does nothing, which looks like
             * the app refusing the owner's own backup.
             */
            @Override
            public boolean onShowFileChooser(WebView v, ValueCallback<Uri[]> cb,
                                             FileChooserParams params) {
                fileCallback = cb;
                try {
                    Intent i = params.createIntent();
                    i.addCategory(Intent.CATEGORY_OPENABLE);
                    startActivityForResult(i, REQ_FILE);
                    return true;
                } catch (android.content.ActivityNotFoundException e) {
                    fileCallback = null;
                    return false;
                }
            }
        });

        web.loadUrl(START_URL);
        setContentView(web);
    }

    /**
     * Answers the app's own requests from the folder on internal storage, so
     * the page keeps a real https origin and localStorage behaves.
     *
     * No-store is deliberate: the only reason a file is asked for again is that
     * a new build was installed, and a cached old one would hide it.
     */
    private WebResourceResponse serveLocal(String host, String path) {
        if (host == null || !host.equals(HOST)) return null;
        String rel = path == null ? "" : path;
        while (rel.startsWith("/")) rel = rel.substring(1);
        if (rel.isEmpty()) rel = "index.html";
        if (rel.contains("..")) return null;

        File dir = AppInstaller.siteDir(this);
        File f = new File(dir, rel);
        if (!f.isFile()) {
            // A path with no extension is a refresh of the single-page app, so
            // it gets index.html. A path that names a real file (sw.js, a
            // script, an icon) must 404 instead: handing back HTML under a
            // .js name fails in a far more confusing way than "not found".
            if (rel.contains(".")) return null;
            f = new File(dir, "index.html");
            if (!f.isFile()) return null;
        }
        try {
            Map<String, String> headers = new HashMap<String, String>();
            headers.put("Cache-Control", "no-store, no-cache, must-revalidate");
            headers.put("Access-Control-Allow-Origin", "*");
            InputStream in = new FileInputStream(f);
            WebResourceResponse r = new WebResourceResponse(mimeOf(rel), "utf-8", in);
            if (Build.VERSION.SDK_INT >= 21) r.setStatusCodeAndReasonPhrase(200, "OK");
            r.setResponseHeaders(headers);
            return r;
        } catch (IOException e) {
            Log.e(TAG, "could not serve " + rel, e);
            return null;
        }
    }

    private static String mimeOf(String name) {
        String n = name.toLowerCase();
        if (n.endsWith(".html") || n.endsWith(".htm")) return "text/html";
        if (n.endsWith(".js")) return "application/javascript";
        if (n.endsWith(".css")) return "text/css";
        if (n.endsWith(".json") || n.endsWith(".webmanifest")) return "application/manifest+json";
        if (n.endsWith(".png")) return "image/png";
        if (n.endsWith(".svg")) return "image/svg+xml";
        if (n.endsWith(".txt")) return "text/plain";
        String guess = URLConnection.guessContentTypeFromName(n);
        return guess == null ? "application/octet-stream" : guess;
    }

    /** Keeps the app on its own pages; anything else opens in the real browser. */
    private boolean openOutside(Uri uri) {
        String scheme = uri.getScheme() == null ? "" : uri.getScheme();
        if (uri.getHost() != null && uri.getHost().equals(HOST)) return false;
        if ("about".equals(scheme) || "blob".equals(scheme) || "data".equals(scheme)) return false;
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, uri));
        } catch (Exception e) {
            Toast.makeText(this, "Ei link ta khola gelo na", Toast.LENGTH_SHORT).show();
        }
        return true;
    }

    // ------------------------------------------------------------------ updates

    private String updateUrl() {
        String u = getSharedPreferences(PREFS, MODE_PRIVATE).getString(KEY_URL, null);
        return (u == null || u.isEmpty()) ? DEFAULT_UPDATE_URL : u;
    }

    /**
     * Looks for a newer build off the main thread, because a slow or dead host
     * must never delay the app opening. A landed update is only announced: the
     * swap already happened on disk, and reloading under the owner mid-memo
     * would be worse than waiting for the next launch.
     */
    private void checkForUpdateInBackground(final boolean tellTheUser) {
        new Thread(new Runnable() {
            public void run() {
                final boolean updated = AppInstaller.downloadUpdate(MainActivity.this, updateUrl());
                final String now = AppInstaller.installedVersion(MainActivity.this);
                if (!tellTheUser && !updated) return;
                runOnUiThread(new Runnable() {
                    public void run() {
                        String msg = updated
                                ? "Notun version " + now + " neme neowa hoyeche.\nApp ta bondho kore abar khulun."
                                : "Already latest (" + now + ").";
                        Toast.makeText(MainActivity.this, msg, Toast.LENGTH_LONG).show();
                    }
                });
            }
        }).start();
    }

    // ------------------------------------------------------------------ menu

    /** Long-press Back is the whole control surface, so the app stays clean. */
    @Override
    public boolean onKeyLongPress(int code, KeyEvent event) {
        if (code == KeyEvent.KEYCODE_BACK) {
            showMenu();
            return true;
        }
        return super.onKeyLongPress(code, event);
    }

    private void showMenu() {
        final String version = AppInstaller.installedVersion(this);
        String[] items = {
                "Update chek korun",
                "Update-er address bodlun",
                "Built-in app-e ferot jan",
        };
        new AlertDialog.Builder(this)
                .setTitle("Texpark Pro " + version)
                .setItems(items, new DialogInterface.OnClickListener() {
                    public void onClick(DialogInterface d, int which) {
                        if (which == 0) checkForUpdateInBackground(true);
                        else if (which == 1) askForUrl();
                        else askReset();
                    }
                })
                .setNegativeButton("Bondho korun", null)
                .show();
    }

    private void askForUrl() {
        final EditText input = new EditText(this);
        input.setInputType(InputType.TYPE_TEXT_VARIATION_URI);
        input.setSingleLine(true);
        input.setHint("https://appleziarash1.github.io/texpark-pro");
        input.setText(updateUrl());

        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        int pad = dp(20);
        box.setPadding(pad, pad / 2, pad, 0);
        TextView help = new TextView(this);
        help.setText("Ei address theke notun version ashe. "
                + "App-er data kono somoy ekhane jay na - shudhu app-er file.");
        LinearLayout.LayoutParams hp = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        hp.bottomMargin = dp(10);
        help.setLayoutParams(hp);
        box.addView(help);
        box.addView(input);

        new AlertDialog.Builder(this)
                .setTitle("Update-er address")
                .setView(box)
                .setPositiveButton("Save", new DialogInterface.OnClickListener() {
                    public void onClick(DialogInterface d, int w) {
                        String u = SiteUrl.normalise(input.getText().toString());
                        if (u == null) {
                            Toast.makeText(MainActivity.this, "Address ta thik noy.",
                                    Toast.LENGTH_LONG).show();
                            return;
                        }
                        getSharedPreferences(PREFS, MODE_PRIVATE).edit()
                                .putString(KEY_URL, u).apply();
                        Toast.makeText(MainActivity.this, "Save hoyeche", Toast.LENGTH_SHORT).show();
                    }
                })
                .setNegativeButton("Cancel", null)
                .show();
    }

    /** Throws away a downloaded update and reinstalls the copy inside the APK. */
    private void askReset() {
        new AlertDialog.Builder(this)
                .setTitle("Built-in app-e ferot?")
                .setMessage("Nemo neowa version ta muche fela hobe, "
                        + "ar APK-er bhitorer version ta chalu hobe.\n\n"
                        + "Apnar data (memo, stock, customer) muchbe na - sob thakbe.")
                .setPositiveButton("Ferot jan", new DialogInterface.OnClickListener() {
                    public void onClick(DialogInterface d, int w) {
                        AppInstaller.resetToBundled(MainActivity.this);
                        if (web != null) web.reload();
                        Toast.makeText(MainActivity.this, "Built-in app chalu hoyeche",
                                Toast.LENGTH_SHORT).show();
                    }
                })
                .setNegativeButton("Cancel", null)
                .show();
    }

    // ------------------------------------------------------------------ bridge

    /** Lets the web app offer Share, and tells it which shell it runs in. */
    private class Bridge {
        @JavascriptInterface
        public void share(final String text) {
            runOnUiThread(new Runnable() {
                public void run() {
                    Intent i = new Intent(Intent.ACTION_SEND);
                    i.setType("text/plain");
                    i.putExtra(Intent.EXTRA_TEXT, text == null ? "" : text);
                    startActivity(Intent.createChooser(i, "Share"));
                }
            });
        }

        @JavascriptInterface
        public String platform() {
            return "android";
        }

        @JavascriptInterface
        public String appVersion() {
            return AppInstaller.installedVersion(MainActivity.this);
        }
    }

    @Override
    protected void onActivityResult(int req, int res, Intent data) {
        if (req == REQ_FILE) {
            if (fileCallback != null) {
                fileCallback.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(res, data));
                fileCallback = null;
            }
            return;
        }
        super.onActivityResult(req, res, data);
    }

    @Override
    public boolean onKeyDown(int code, KeyEvent event) {
        if (code == KeyEvent.KEYCODE_BACK && web != null && web.canGoBack()) {
            web.goBack();
            return true;
        }
        return super.onKeyDown(code, event);
    }

    private int dp(int v) {
        return (int) TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v,
                getResources().getDisplayMetrics());
    }
}
