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
    public static final String APP_VERSION = "2027-01-01.8";

    private static final String PREFS = "texpark_pro_shell";
    private static final String KEY_URL = "update_url";

    /**
     * Where the WebView shell kept the same address before this app replaced it.
     *
     * The owner could have typed a custom address there. Reading it once means an
     * install that came from the old shell does not silently start checking a
     * different host than the one it was pointed at.
     */
    private static final String OLD_PREFS = "texpark";
    private static final String OLD_KEY_URL = "site_url";

    /** Where the released APK lives, so an old install can still find a new one. */
    static final String DEFAULT_UPDATE_URL = "https://appleziarash1.github.io/texpark-pro";

    private Store store;
    private Screens screens;
    private LinearLayout navWrap;
    private View dim;
    private TextView badge;
    private TextToSpeech tts;
    private boolean ttsReady = false;

    /** The last time an automatic poll ran, and the pushes waiting to go up.
     *
     *  A shop phone saves constantly - a memo, then a stock top-up, then a
     *  correction - and pushing after each one would spend the owner's data on
     *  snapshots that are stale by the time they arrive. A short quiet period
     *  coalesces a burst of edits into one upload. */
    private long lastPollAt = 0L;
    private long lastPushAt = 0L;
    private boolean pushScheduled = false;
    private final android.os.Handler syncHandler = new android.os.Handler();
    private Runnable pushTask;
    private Runnable pollTask;
    private static final long PUSH_QUIET_MS = 2000L;
    /** How often the open app re-reads the sheet. Matches the web tab's timer and
     *  Sync.POLL_EVERY_MS, so neither side polls harder than the other. */
    private static final long POLL_TICK_MS = 30000L;

    private static final int REQ_VOICE = 4001;

    /* ------------------------------------------------------------ lifecycle */

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().setBackgroundDrawableResource(android.R.color.white);

        store = new Store(getFilesDir());
        store.load();
        Sync.appVersion = APP_VERSION;
        buildChrome();

        /* Every save asks for an upload. This is the fix for the phone's edits never
           reaching the sheet: syncing only when the app opened meant a memo typed
           mid-morning sat on the phone until the app was restarted, and a PC looking
           at the web app saw yesterday's numbers. */
        store.setListener(new Store.Listener() {
            public void onDataChanged() { schedulePush(); }
        });

        screens = new Screens(this, store, contentHolder, badge, navWrap, dim);
        setupTts();
        screens.render();
        checkForUpdateInBackground();
        autoSyncQuietly();
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
        startPolling();
    }

    @Override
    protected void onPause() {
        super.onPause();
        stopPolling();
        // Leaving the app is the moment a pending upload matters most: the owner is
        // about to look at it from somewhere else, and the quiet period may not have
        // elapsed yet.
        if (pushScheduled) {
            syncHandler.removeCallbacks(pushTask);
            pushTask.run();
        }
    }

    /** Polls the sheet every 30 seconds for as long as the app is on screen.
     *  A shop phone is usually sitting open on the counter, and until now a memo
     *  entered on the PC only appeared after the owner closed and reopened the app.
     *  The poll stops in onPause, so it never runs behind the owner's back - a
     *  background poll would spend his data to refresh a screen nobody is reading. */
    private void startPolling() {
        if (pollTask == null) {
            pollTask = new Runnable() {
                public void run() {
                    autoSyncQuietly();
                    syncHandler.postDelayed(pollTask, POLL_TICK_MS);
                }
            };
        }
        syncHandler.removeCallbacks(pollTask);
        syncHandler.postDelayed(pollTask, POLL_TICK_MS);
    }

    private void stopPolling() {
        if (pollTask != null) syncHandler.removeCallbacks(pollTask);
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
        if (u == null || u.isEmpty()) {
            // An install that started life as the WebView shell has its address
            // under the old key, and the owner may have typed a custom one there.
            u = getSharedPreferences(OLD_PREFS, MODE_PRIVATE).getString(OLD_KEY_URL, null);
        }
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
        new Thread(new Runnable() {
            public void run() {
                final String url = releaseWithNewerApk();
                if (url == null) return;
                runOnUiThread(new Runnable() {
                    public void run() { offerDownloadOnly(url); }
                });
            }
        }).start();
    }

    /**
     * The first host that is publishing something newer than this build, or null.
     *
     * The owner's own address is tried first. The released address is tried after
     * it, because an install pointed at a mirror that has since been frozen - or at
     * a host that has gone away - would otherwise never hear about a new build and
     * would sit on a version with a bug he already reported.
     */
    private String releaseWithNewerApk() {
        String configured = updateUrl();
        if (Updater.hasNewerRelease(configured, APP_VERSION)) return configured;
        String released = DEFAULT_UPDATE_URL;
        if (!trimSlash(released).equalsIgnoreCase(trimSlash(configured))
                && Updater.hasNewerRelease(released, APP_VERSION)) {
            return released;
        }
        return null;
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
        // Opening screen after screen is normal; without this each one would fetch
        // the sheet and spend the owner's data on an answer he already has.
        if (!Sync.pollDue(lastPollAt, System.currentTimeMillis())) return;
        lastPollAt = System.currentTimeMillis();
        new Thread(new Runnable() {
            public void run() {
                String before = store.snapshotJson();
                // pullAll pushes first and reports whether that upload worked, so
                // there is no separate push here.
                Sync.pullAll(store, url);
                // Redraw only when the merge actually moved something. A rebuild on
                // every poll would close whatever the owner had open and drop the
                // caret out of the field he is typing in, every 30 seconds, for no
                // reason at all on the many polls that find nothing new.
                if (store.snapshotJson().equals(before)) return;
                runOnUiThread(new Runnable() { public void run() { screens.render(); } });
            }
        }).start();
    }

    /* ------------------------------------------------------------ push on save */

    /**
     * Queues an upload of this device's snapshot.
     *
     * Called after every commit, so a memo or a stock change reaches the sheet
     * while the owner is still holding the phone rather than at the next launch.
     * Offline is the normal state of a shop phone, so failure is retried on the
     * next save and on the next open instead of interrupting him with a dialog.
     */
    private void schedulePush() {
        if (pushTask == null) {
            pushTask = new Runnable() {
                public void run() { pushNow(); }
            };
        }
        syncHandler.removeCallbacks(pushTask);
        pushScheduled = true;
        syncHandler.postDelayed(pushTask, PUSH_QUIET_MS);
    }

    /** True once, allowing only one upload at a time; false if one is already out. */
    private boolean claimPush() {
        long now = System.currentTimeMillis();
        if (now - lastPushAt < 1000L) return false;
        lastPushAt = now;
        return true;
    }

    private void pushNow() {
        pushScheduled = false;
        if (store.session == null) return;
        if (Boolean.FALSE.equals(store.settings().get("autoPull"))) return;
        final String url = Store.str(store.settings(), "syncUrl");
        if (url.isEmpty()) return;
        if (!claimPush()) return;
        new Thread(new Runnable() {
            public void run() { Sync.backupQuiet(store, url); }
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
