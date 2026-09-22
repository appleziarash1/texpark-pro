package com.texpark.pro;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.util.TypedValue;
import android.view.KeyEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.view.WindowManager;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.PermissionRequest;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;

/**
 * A shell around the Texpark Pro web app.
 *
 * It deliberately does not ship a copy of the app. The address of the hosted
 * site is stored once and the WebView loads it live, so a fix uploaded to the
 * host shows up here on the next launch without rebuilding or reinstalling.
 */
public class MainActivity extends Activity {

    private static final String PREFS = "texpark";
    private static final String KEY_URL = "site_url";
    private static final int REQ_FILE = 1001;

    private WebView web;
    private View setupView;
    private ValueCallback<Uri[]> fileCallback;
    private boolean loadFailedShown;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        getWindow().setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE);
        if (Build.VERSION.SDK_INT >= 21) {
            Window w = getWindow();
            w.addFlags(WindowManager.LayoutParams.FLAG_DRAWS_SYSTEM_BAR_BACKGROUNDS);
            w.setStatusBarColor(Color.parseColor("#12366b"));
        }
        String url = getSharedPreferences(PREFS, MODE_PRIVATE).getString(KEY_URL, null);
        if (url == null || url.isEmpty()) {
            showSetup();
        } else {
            showApp(url);
        }
    }

    // ------------------------------------------------------------- setup UI
    private void showSetup() {
        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setBackgroundColor(Color.parseColor("#eef3f9"));
        int pad = dp(28);
        box.setPadding(pad, dp(56), pad, pad);

        TextView title = new TextView(this);
        title.setText("Texpark Pro");
        title.setTextSize(TypedValue.COMPLEX_UNIT_SP, 30);
        title.setTextColor(Color.parseColor("#12366b"));
        title.setTypeface(title.getTypeface(), android.graphics.Typeface.BOLD);
        box.addView(title);

        TextView help = new TextView(this);
        help.setText(getString(R.string.enter_url)
                + "\n\nEkbar bosalei hobe. Pore app nijei update hobe \u2014 notun APK lagbe na.");
        help.setTextSize(TypedValue.COMPLEX_UNIT_SP, 15);
        help.setTextColor(Color.parseColor("#4a5b73"));
        LinearLayout.LayoutParams hp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        hp.topMargin = dp(14);
        help.setLayoutParams(hp);
        box.addView(help);

        final EditText input = new EditText(this);
        input.setHint(R.string.url_hint);
        input.setSingleLine(true);
        input.setTextSize(TypedValue.COMPLEX_UNIT_SP, 16);
        input.setBackgroundColor(Color.WHITE);
        input.setPadding(dp(14), dp(16), dp(14), dp(16));
        LinearLayout.LayoutParams ip = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        ip.topMargin = dp(22);
        input.setLayoutParams(ip);
        box.addView(input);

        Button go = new Button(this);
        go.setText(R.string.start);
        go.setAllCaps(false);
        go.setTextSize(TypedValue.COMPLEX_UNIT_SP, 18);
        go.setBackgroundColor(Color.parseColor("#f22b70"));
        go.setTextColor(Color.WHITE);
        LinearLayout.LayoutParams gp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, dp(56));
        gp.topMargin = dp(18);
        go.setLayoutParams(gp);
        box.addView(go);

        go.setOnClickListener(new View.OnClickListener() {
            public void onClick(View v) {
                String u = SiteUrl.normalise(input.getText().toString());
                if (u == null) {
                    Toast.makeText(MainActivity.this, R.string.bad_url, Toast.LENGTH_LONG).show();
                    return;
                }
                getSharedPreferences(PREFS, MODE_PRIVATE).edit()
                        .putString(KEY_URL, u).apply();
                showApp(u);
            }
        });

        setupView = box;
        setContentView(box);
    }

    // --------------------------------------------------------------- webview
    private void showApp(String url) {
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
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);
        if (Build.VERSION.SDK_INT >= 21) {
            CookieManager.getInstance().setAcceptThirdPartyCookies(web, true);
        }

        web.addJavascriptInterface(new Bridge(), "AndroidBridge");

        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest r) {
                return handleUrl(v, r.getUrl());
            }

            @Override
            @SuppressWarnings("deprecation")
            public boolean shouldOverrideUrlLoading(WebView v, String u) {
                return handleUrl(v, Uri.parse(u));
            }

            @Override
            public void onReceivedError(WebView v, WebResourceRequest req,
                                        android.webkit.WebResourceError err) {
                if (req.isForMainFrame()) showLoadFailed();
            }

            @Override
            @SuppressWarnings("deprecation")
            public void onReceivedError(WebView v, int code, String desc, String failingUrl) {
                if (failingUrl != null && failingUrl.equals(v.getUrl())) showLoadFailed();
            }

            @Override
            public void onReceivedHttpError(WebView v, WebResourceRequest req,
                                            android.webkit.WebResourceResponse res) {
                // A 404 on the main frame means the stored address is wrong.
                if (req.isForMainFrame() && res.getStatusCode() >= 400) showLoadFailed();
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

            @Override
            public boolean onShowFileChooser(WebView v, ValueCallback<Uri[]> cb,
                                             FileChooserParams params) {
                fileCallback = cb;
                try {
                    Intent i = params.createIntent();
                    i.addCategory(Intent.CATEGORY_OPENABLE);
                    startActivityForResult(i, REQ_FILE);
                    return true;
                } catch (ActivityNotFoundException e) {
                    fileCallback = null;
                    return false;
                }
            }
        });

        web.loadUrl(url);
        setContentView(web);
        setupView = null;
    }

    /**
     * The stored address is wrong or the site is down. Without this the user
     * would stare at a blank page with no way to fix or change the address.
     */
    private void showLoadFailed() {
        if (loadFailedShown) return;
        loadFailedShown = true;
        runOnUiThread(new Runnable() {
            public void run() {
                final String bad = getSharedPreferences(PREFS, MODE_PRIVATE)
                        .getString(KEY_URL, "");
                android.app.AlertDialog.Builder b =
                        new android.app.AlertDialog.Builder(MainActivity.this);
                b.setTitle("Site ta khola gelo na");
                b.setMessage("Address ta holo:\n" + bad
                        + "\n\nInternet ache kina dekhen, ar address ta thik ache kina.\n"
                        + "Address bodlate chaile 'Address bodlun' chepun.");
                b.setCancelable(false);
                b.setPositiveButton("Abar chesta korun", new android.content.DialogInterface.OnClickListener() {
                    public void onClick(android.content.DialogInterface d, int w) {
                        loadFailedShown = false;
                        if (web != null) web.reload();
                    }
                });
                b.setNeutralButton("Address bodlun", new android.content.DialogInterface.OnClickListener() {
                    public void onClick(android.content.DialogInterface d, int w) {
                        loadFailedShown = false;
                        getSharedPreferences(PREFS, MODE_PRIVATE).edit()
                                .remove(KEY_URL).apply();
                        showSetup();
                    }
                });
                b.show();
            }
        });
    }

    /** Keeps the app inside its own site; sends everything else to the browser. */
    private boolean handleUrl(WebView v, Uri uri) {
        String scheme = uri.getScheme() == null ? "" : uri.getScheme();
        String here = v.getUrl() == null ? "" : v.getUrl();
        String hereHost = Uri.parse(here).getHost();
        if (hereHost == null) hereHost = "";

        boolean internal = "about".equals(scheme) || "blob".equals(scheme)
                || "data".equals(scheme)
                || (uri.getHost() != null && uri.getHost().equals(hereHost));
        if (internal) return false;

        try {
            startActivity(new Intent(Intent.ACTION_VIEW, uri));
        } catch (Exception e) {
            Toast.makeText(this, "Ei link ta khola gelo na", Toast.LENGTH_SHORT).show();
        }
        return true;
    }

    // ------------------------------------------------------------------- bridge
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
    }

    @Override
    protected void onActivityResult(int req, int res, Intent data) {
        if (req == REQ_FILE) {
            if (fileCallback != null) {
                fileCallback.onReceiveValue(
                        WebChromeClient.FileChooserParams.parseResult(res, data));
                fileCallback = null;
            }
            return;
        }
        super.onActivityResult(req, res, data);
    }

    @Override
    public boolean onKeyDown(int code, KeyEvent event) {
        if (code == KeyEvent.KEYCODE_BACK && setupView == null && web != null) {
            if (web.canGoBack()) {
                web.goBack();
                return true;
            }
            // Back on the first page: give a way out rather than quitting.
            if (event.getRepeatCount() == 0) {
                Toast.makeText(this, "Abar chepe ber hobo \u00b7 chhere dhore address bodlun",
                        Toast.LENGTH_SHORT).show();
                return true;
            }
        }
        return super.onKeyDown(code, event);
    }

    /** Long-pressing Back lets the owner point the app at a different address. */
    @Override
    public boolean onKeyLongPress(int code, KeyEvent event) {
        if (code == KeyEvent.KEYCODE_BACK && setupView == null) {
            getSharedPreferences(PREFS, MODE_PRIVATE).edit().remove(KEY_URL).apply();
            showSetup();
            return true;
        }
        return super.onKeyLongPress(code, event);
    }

    private int dp(int v) {
        return (int) TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v,
                getResources().getDisplayMetrics());
    }
}