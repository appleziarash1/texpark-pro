package com.texpark.pro;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.DialogInterface;
import android.content.Intent;
import android.content.res.Configuration;
import android.graphics.Color;
import android.graphics.Typeface;
import android.net.Uri;
import android.os.Bundle;
import android.speech.RecognizerIntent;
import android.speech.tts.TextToSpeech;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.View;
import android.view.ViewGroup;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * Texpark Pro - a fully native business app for TEXPARK BUYING HOUSE.
 *
 * This replaced a WebView that wrapped the hosted site. The owner asked for a real
 * Android app, and the honest reason the WebView was wrong is worth recording: a
 * memo could not be printed on Android at all, because window.print() does nothing
 * inside a WebView, and printing memos is the shop's main job. Native also gets the
 * real keyboard, the real date picker, the real back button and the real voice
 * recogniser, which is what a shop app needs.
 *
 * Everything that decides money lives in {@link Store}, which has no Android
 * imports and is tested on a plain JVM against the web app's own rules. This class
 * is only the shell: top bar, sidebar, back handling, updates and voice.
 */
public class MainActivity extends Activity {

    /** Shown in Settings. build-apk.py rewrites this line to the built version. */
    public static final String APP_VERSION = "2027-01-01.1";

    private static final String PREFS = "texpark_pro_shell";
    private static final String KEY_URL = "update_url";

    /** Where the released APK lives, so an old install can still find a new one. */
    static final String DEFAULT_UPDATE_URL = "https://appleziarash1.github.io/texpark-pro";

    private Store store;
    private Screens screens;
    private LinearLayout navWrap;
    private View dim;
    private TextView badge;
    private TextToSpeech tts;
    private boolean ttsReady = false;

    private static final int REQ_VOICE = 4001;

    /* ------------------------------------------------------------ lifecycle */

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().setBackgroundDrawableResource(android.R.color.white);

        store = new Store(getFilesDir());
        store.load();
        buildChrome();

        screens = new Screens(this, store, contentHolder, badge, navWrap, dim);
        setupTts();
        screens.render();
        checkForUpdateInBackground();
    }

    @Override
    protected void onDestroy() {
        if (tts != null) {
            tts.stop();
            tts.shutdown();
        }
        super.onDestroy();
    }

    @Override
    protected void onResume() {
        super.onResume();
        autoSyncQuietly();
    }

    @Override
    public void onConfigurationChanged(Configuration newConfig) {
        super.onConfigurationChanged(newConfig);
        // Rotating must not cost the owner a half-typed memo, so the draft is kept
        // in Screens and the screen is simply redrawn from it.
        if (screens != null) screens.render();
    }

    /* ------------------------------------------------------------ chrome */

    private LinearLayout contentHolder;

    private void buildChrome() {
        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(Ui.BG);

        LinearLayout frame = new LinearLayout(this);
        frame.setOrientation(LinearLayout.VERTICAL);
        frame.setLayoutParams(new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        LinearLayout bar = new LinearLayout(this);
        bar.setOrientation(LinearLayout.HORIZONTAL);
        bar.setGravity(Gravity.CENTER_VERTICAL);
        bar.setBackgroundColor(Ui.NAVY);
        int p = Ui.dp(this, 10);
        bar.setPadding(p, p, p, p);

        TextView menu = new TextView(this);
        menu.setText("\u2630");
        menu.setTextColor(Color.WHITE);
        menu.setTextSize(22f);
        menu.setPadding(0, 0, Ui.dp(this, 12), 0);
        menu.setOnClickListener(new View.OnClickListener() {
            public void onClick(View v) {
                if (screens != null) screens.openNav(!screens.navOpen);
            }
        });
        bar.addView(menu);

        LinearLayout titles = Ui.col(this);
        TextView title = new TextView(this);
        title.setText("TEXPARK Pro");
        title.setTextColor(Color.WHITE);
        title.setTextSize(16f);
        title.setTypeface(Typeface.DEFAULT_BOLD);
        badge = new TextView(this);
        badge.setTextColor(0xFFB9C8DE);
        badge.setTextSize(11f);
        titles.addView(title);
        titles.addView(badge);
        titles.setLayoutParams(new LinearLayout.LayoutParams(0,
                ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
        bar.addView(titles);

        TextView mic = new TextView(this);
        mic.setText("\uD83C\uDFA4");
        mic.setTextColor(Color.WHITE);
        mic.setTextSize(20f);
        mic.setOnClickListener(new View.OnClickListener() {
            public void onClick(View v) { startVoice(); }
        });
        bar.addView(mic);

        frame.addView(bar);

        contentHolder = Ui.col(this);
        ScrollView shellScroll = new ScrollView(this);
        shellScroll.setLayoutParams(new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f));
        shellScroll.addView(contentHolder);
        frame.addView(shellScroll);

        navWrap = Ui.col(this);
        navWrap.setBackgroundColor(0xFF0E2A52);
        navWrap.setVisibility(View.GONE);
        navWrap.setLayoutParams(new FrameLayout.LayoutParams(
                Ui.dp(this, 262), ViewGroup.LayoutParams.MATCH_PARENT));

        dim = new View(this);
        dim.setBackgroundColor(0x99000000);
        dim.setVisibility(View.GONE);
        dim.setOnClickListener(new View.OnClickListener() {
            public void onClick(View v) { if (screens != null) screens.openNav(false); }
        });
        dim.setLayoutParams(new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        root.addView(frame);
        root.addView(dim);
        root.addView(navWrap);
        setContentView(root);
    }

    /* ------------------------------------------------------------ back */

    @Override
    public boolean onKeyDown(int code, KeyEvent event) {
        if (code != KeyEvent.KEYCODE_BACK) return super.onKeyDown(code, event);
        if (navWrap != null && navWrap.getVisibility() == View.VISIBLE) {
            screens.openNav(false);
            return true;
        }
        if (screens != null && !"dashboard".equals(screens.page)) {
            screens.go("dashboard");
            return true;
        }
        // Back on the dashboard is the exit gesture, but it asks first: a stray
        // press while a memo is open must not close the app.
        new AlertDialog.Builder(this)
            .setMessage("App ta bondho korben?")
            .setPositiveButton("Hyan", new DialogInterface.OnClickListener() {
                public void onClick(DialogInterface d, int w) { finish(); }
            })
            .setNegativeButton("Na", null)
            .show();
        return true;
    }

    /* ------------------------------------------------------------ voice */

    private void setupTts() {
        try {
            tts = new TextToSpeech(this, new TextToSpeech.OnInitListener() {
                public void onInit(int status) {
                    ttsReady = status == TextToSpeech.SUCCESS;
                    if (!ttsReady) return;
                    int r = tts.setLanguage(new Locale("bn", "BD"));
                    if (r == TextToSpeech.LANG_MISSING_DATA
                            || r == TextToSpeech.LANG_NOT_SUPPORTED) {
                        tts.setLanguage(Locale.US);   // still useful, just not Bangla
                    }
                }
            });
        } catch (Exception e) {
            tts = null;                               // no engine: voice still types
        }
    }

    /**
     * Voice entry.
     *
     * The recogniser is asked for Bangla, because a bn-BD phone returns Bangla
     * script for "বিক্রি" while an English-set phone returns roman - and the shop's
     * product names happen to be roman either way.
     */
    private void startVoice() {
        if (store.session == null) { toast("Age login korun."); return; }
        try {
            Intent i = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
            i.putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL,
                    RecognizerIntent.LANGUAGE_MODEL_FREE_FORM);
            i.putExtra(RecognizerIntent.EXTRA_LANGUAGE, "bn-BD");
            i.putExtra(RecognizerIntent.EXTRA_PROMPT,
                    "Boliye din \u2014 jemon: \"Kids 3pcs 5 piece\"");
            startActivityForResult(i, REQ_VOICE);
        } catch (Exception e) {
            toast("Ei phone-e voice recognition nei. Google app install korun.");
        }
    }

    @Override
    protected void onActivityResult(int req, int res, Intent data) {
        if (req == REQ_VOICE) {
            if (res != RESULT_OK || data == null) return;
            List<String> heard = data.getStringArrayListExtra(RecognizerIntent.EXTRA_RESULTS);
            if (heard == null || heard.isEmpty()) return;
            handleVoice(heard.get(0));
            return;
        }
        super.onActivityResult(req, res, data);
    }

    /**
     * Acts on one spoken sentence: either a stock receipt or a memo line.
     *
     * A receipt is applied straight away - the owner said so and the quantity is
     * the whole message. A sale only fills the memo form: a spoken sentence carries
     * no price, and inventing one would put a wrong figure on a memo that has
     * already gone to a customer. The reading itself lives in {@link Voice}, where
     * it is tested off-device.
     */
    private void handleVoice(String text) {
        Voice.Reading r = Voice.read(store, text);

        if (r.product == null) {
            say("Ei product ta chinlam na.");
            toast("Product chinlam na. Products page-e nam ta din.");
            return;
        }
        if (r.intent == Voice.Intent.UNKNOWN) {
            say(r.productName + " — ashlo na bikri, seta bolun.");
            toast("Bujhlam na. Bolun \"ashlo\" ba \"bikri\" shobdo diye.");
            return;
        }
        if (r.qty <= 0) {
            say(r.productName + " er poriman bolun.");
            toast(r.productName + " pelam, kintu koto piece seta bolun.");
            return;
        }

        if (r.intent == Voice.Intent.RECEIPT) {
            String pid = Store.str(r.product, "id");
            Map<String, Object> card = store.stockOf(pid);
            card.put("opening", Double.valueOf(Store.num(card.get("opening")) + r.qty));
            card.put("available", Double.valueOf(Store.stockAvailable(card)));
            store.logStock(pid, "Opening", r.qty, "Voice", "Voice: " + r.heard);
            store.commit();
            say(r.productName + " " + Ui.qty(r.qty) + " piece stock-e jog holo.");
            screens.render();
            return;
        }

        screens.go("memo");
        Screens.MemoDraft.Line line;
        if (screens.draft.lines.size() == 1 && screens.draft.lines.get(0).productId.isEmpty()) {
            line = screens.draft.lines.get(0);
        } else {
            line = new Screens.MemoDraft.Line();
            screens.draft.lines.add(line);
        }
        line.productId = Store.str(r.product, "id");
        line.qty = Ui.qty(r.qty);
        line.rate = Ui.qty(r.product.get("rate"));
        line.cost = Ui.qty(store.stockCost(Store.str(r.product, "id")));
        screens.render();
        say(r.productName + " " + Ui.qty(r.qty) + " piece memo-te dilam. Rate dekhe save korun.");
    }

    private void say(String text) {
        if (!ttsReady || tts == null) return;
        try {
            tts.speak(text, TextToSpeech.QUEUE_FLUSH, null);
        } catch (Exception ignored) { }
    }

    void toast(String m) { Toast.makeText(this, m, Toast.LENGTH_LONG).show(); }

    /* ------------------------------------------------------------ updates */

    /** The address the owner keeps, editable in Settings so a moved site still works. */
    String updateUrl() {
        String u = getSharedPreferences(PREFS, MODE_PRIVATE).getString(KEY_URL, null);
        return (u == null || u.isEmpty()) ? DEFAULT_UPDATE_URL : u;
    }

    void setUpdateUrl(String url) {
        getSharedPreferences(PREFS, MODE_PRIVATE).edit().putString(KEY_URL, url).apply();
    }

    /**
     * Checks for a newer APK quietly on launch.
     *
     * Offline is the normal state of a shop phone, so a check that cannot reach the
     * host says nothing at all rather than raising an error the owner would learn
     * to dismiss.
     */
    private void checkForUpdateInBackground() {
        final String url = updateUrl();
        new Thread(new Runnable() {
            public void run() {
                if (!Updater.hasNewerRelease(url, APP_VERSION)) return;
                runOnUiThread(new Runnable() {
                    public void run() { offerDownloadOnly(url); }
                });
            }
        }).start();
    }

    /** Points at the newer APK. See {@link Updater#hasNewerRelease} for why the
     *  downloaded APK cannot be installed silently. */
    private void offerDownloadOnly(final String url) {
        new AlertDialog.Builder(this)
            .setTitle("Notun version ache")
            .setMessage("App-er notun version ber hoyeche. Download kore install korben?\n\n"
                    + "Apnar data (memo, stock, customer) muchbe na \u2014 sob thakbe.")
            .setPositiveButton("Download", new DialogInterface.OnClickListener() {
                public void onClick(DialogInterface d, int w) {
                    try {
                        startActivity(new Intent(Intent.ACTION_VIEW,
                                Uri.parse(trimSlash(url) + "/TexparkPro.apk")));
                        toast("Download shesh hole file ta tap kore install korun.");
                    } catch (Exception e) {
                        toast("Browser khola gelo na.");
                    }
                }
            })
            .setNegativeButton("Pore", null)
            .show();
    }

    private static String trimSlash(String s) {
        String out = s == null ? "" : s.trim();
        while (out.endsWith("/")) out = out.substring(0, out.length() - 1);
        return out;
    }

    /* ------------------------------------------------------------ autosync */

    /**
     * Pushes this device's snapshot and merges the others, off the UI thread and
     * without a toast. A phone is offline often; announcing every failure would
     * teach the owner to ignore the one message that matters.
     */
    private void autoSyncQuietly() {
        if (store.session == null) return;
        if (Boolean.FALSE.equals(store.settings().get("autoPull"))) return;
        final String url = Store.str(store.settings(), "syncUrl");
        if (url.isEmpty()) return;
        new Thread(new Runnable() {
            public void run() { Sync.pullAll(store, url); }
        }).start();
    }

    /* ------------------------------------------------------------ backup files */

    /** Writes a backup into the app's private folder. Returns the path, or null. */
    public static String writeBackup(Store store) {
        File f = new File(store.dbDir(), "texpark-backup-" + Store.today() + ".json");
        FileOutputStream out = null;
        try {
            out = new FileOutputStream(f);
            out.write(Json.write(store.db).getBytes("UTF-8"));
            out.flush();
            return f.getAbsolutePath();
        } catch (IOException e) {
            return null;
        } finally {
            if (out != null) try { out.close(); } catch (IOException ignored) { }
        }
    }

    public static List<Object> listSnapshots(Store store) { return store.listSnapshots(); }

    public static String restoreSnapshot(Store store, int index) {
        return store.restoreSnapshot(index);
    }
}
