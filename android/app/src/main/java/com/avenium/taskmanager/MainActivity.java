package com.avenium.taskmanager;

import android.Manifest;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Build;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.graphics.Bitmap;
import android.net.http.SslError;
import android.view.Gravity;
import android.widget.FrameLayout;
import android.widget.TextView;
import android.speech.RecognizerIntent;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import org.json.JSONObject;
import java.util.ArrayList;
import android.webkit.SslErrorHandler;
import android.webkit.WebResourceError;
import android.webkit.WebResourceResponse;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import androidx.appcompat.app.AppCompatActivity;

public class MainActivity extends AppCompatActivity {
    private static final String START_URL = "https://tasks.avenium.com";
    private static final int FILE_CHOOSER = 1001;
    private static final int SPEECH = 1002;
    private WebView webView;
    private ValueCallback<Uri[]> fileCallback;
    private TextView status;

    private void log(String msg) {
        runOnUiThread(() -> {
            status.append(msg + "\n");
            if (msg.startsWith("ERROR") || msg.startsWith("SSL") || msg.startsWith("HTTP 5"))
                status.setVisibility(android.view.View.VISIBLE);
        });
    }

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        setTheme(R.style.AppTheme_NoActionBar);
        super.onCreate(savedInstanceState);

        webView = new WebView(this);
        webView.setBackgroundColor(Color.parseColor("#6b8f79"));
        WebView.setWebContentsDebuggingEnabled(true);
        FrameLayout root = new FrameLayout(this);
        root.addView(webView);
        status = new TextView(this);
        status.setTextColor(Color.WHITE);
        status.setBackgroundColor(Color.parseColor("#CC000000"));
        status.setTextSize(13);
        status.setPadding(32, 120, 32, 32);
        FrameLayout.LayoutParams lp = new FrameLayout.LayoutParams(
            FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.WRAP_CONTENT, Gravity.TOP);
        root.addView(status, lp);
        setContentView(root);
        status.setText("Avenium Tasks could not load. Details:\n");
        status.setVisibility(android.view.View.GONE);

        WebSettings s = webView.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setLoadWithOverviewMode(true);
        s.setUseWideViewPort(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        // Lets the website know it is inside the app (the app shows reminders itself)
        s.setUserAgentString(s.getUserAgentString() + " AveniumTasksApp/1");
        // The website's microphone buttons use the phone's own voice typing through this
        webView.addJavascriptInterface(new SpeechBridge(), "AveniumNative");

        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(webView, true);

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public void onPageStarted(WebView view, String url, Bitmap favicon) {
                log("Loading: " + url);
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                log("Finished: " + url + " (title: " + view.getTitle() + ")");
                if (view.getTitle() != null && view.getTitle().contains("Avenium")) {
                    view.postDelayed(() -> status.setVisibility(android.view.View.GONE), 1500);
                }
                // Signed in: book this phone's reminder alarms, and ask once to show notifications
                if (url != null && url.startsWith(START_URL) && !url.contains("/login")) {
                    CookieManager.getInstance().flush();
                    ReminderSync.syncAsync(MainActivity.this);
                    askForNotifications();
                }
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest req, WebResourceError err) {
                log("ERROR " + err.getErrorCode() + ": " + err.getDescription() + " @ " + req.getUrl());
            }

            @Override
            public void onReceivedHttpError(WebView view, WebResourceRequest req, WebResourceResponse resp) {
                log("HTTP " + resp.getStatusCode() + " " + resp.getReasonPhrase() + " @ " + req.getUrl());
            }

            @Override
            public void onReceivedSslError(WebView view, SslErrorHandler handler, SslError error) {
                log("SSL ERROR " + error.getPrimaryError() + " @ " + error.getUrl());
                handler.cancel();
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                String host = uri.getHost();
                if (host != null && host.endsWith("avenium.com")) return false;
                // Open external links (mailto, tel, other sites) outside the app
                try { startActivity(new Intent(Intent.ACTION_VIEW, uri)); } catch (Exception ignored) {}
                return true;
            }
        });

        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onProgressChanged(WebView view, int p) {
                if (p == 10 || p == 50 || p == 100) log("Progress " + p + "%");
            }

            @Override
            public boolean onConsoleMessage(android.webkit.ConsoleMessage m) {
                if (m.messageLevel() == android.webkit.ConsoleMessage.MessageLevel.ERROR)
                    log("JS: " + m.message());
                return true;
            }

            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (fileCallback != null) fileCallback.onReceiveValue(null);
                fileCallback = callback;
                try {
                    startActivityForResult(params.createIntent(), FILE_CHOOSER);
                } catch (Exception e) {
                    fileCallback = null;
                    return false;
                }
                return true;
            }
        });

        log("WebView: " + s.getUserAgentString());
        webView.loadUrl(START_URL);
    }

    /** window.AveniumNative.startSpeech(lang): opens Android's voice typing; the words go back to the page. */
    private class SpeechBridge {
        @JavascriptInterface
        public void startSpeech(final String lang) {
            runOnUiThread(() -> {
                Intent i = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
                i.putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM);
                if (lang != null && !lang.isEmpty()) i.putExtra(RecognizerIntent.EXTRA_LANGUAGE, lang);
                i.putExtra(RecognizerIntent.EXTRA_PROMPT, "Speak now");
                try {
                    startActivityForResult(i, SPEECH);
                } catch (Exception e) {
                    speechResult(null, "unavailable");
                }
            });
        }
    }

    private void speechResult(String text, String err) {
        String js = "window.__aveniumSpeechResult && window.__aveniumSpeechResult(" +
                JSONObject.quote(text == null ? "" : text) + "," + (err == null ? "null" : JSONObject.quote(err)) + ")";
        webView.evaluateJavascript(js, null);
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == SPEECH) {
            ArrayList<String> words = (resultCode == RESULT_OK && data != null) ? data.getStringArrayListExtra(RecognizerIntent.EXTRA_RESULTS) : null;
            if (words != null && !words.isEmpty()) speechResult(words.get(0), null);
            else speechResult(null, "cancelled");
            return;
        }
        if (requestCode == FILE_CHOOSER && fileCallback != null) {
            fileCallback.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(resultCode, data));
            fileCallback = null;
        }
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        webView.saveState(outState);
    }

    @Override
    protected void onPause() {
        super.onPause();
        CookieManager.getInstance().flush();
        ReminderSync.syncAsync(this);   // pick up anything added or changed while the app was open
    }

    private boolean askedForNotifications = false;
    private void askForNotifications() {
        ReminderSync.ensureChannel(this);
        ReminderSync.ensurePeriodic(this);
        if (askedForNotifications || Build.VERSION.SDK_INT < 33) return;
        askedForNotifications = true;
        if (checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[] { Manifest.permission.POST_NOTIFICATIONS }, 7);
        }
    }

    @Override
    public void onBackPressed() {
        if (webView.canGoBack()) webView.goBack();
        else super.onBackPressed();
    }
}
