package com.avenium.taskmanager;

import android.app.AlarmManager;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Build;
import android.service.notification.StatusBarNotification;
import android.webkit.CookieManager;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.HashSet;
import java.util.Set;
import java.util.TimeZone;

/**
 * Reminders that pop up even when the app is closed.
 *
 * The server already knows every reminder (meetings / appointments a set time
 * before, birthdays etc. the day before and the day of, minus anything dismissed
 * or snoozed on any device). This downloads the next few days of them and books
 * a phone alarm for each; ReminderReceiver shows the notification when it rings.
 */
public final class ReminderSync {
    static final String BASE = "https://tasks.avenium.com";
    static final String PREFS = "reminders";
    static final String CHANNEL = "reminders";
    static final int NOTIF_ID = 4711;
    private static final int PERIODIC_RC = 900001;

    private ReminderSync() {}

    /** Re-download and re-book every reminder, off the main thread. */
    static void syncAsync(Context ctx) {
        final Context app = ctx.getApplicationContext();
        new Thread(() -> {
            try { sync(app); } catch (Throwable ignored) {}
        }, "reminder-sync").start();
    }

    /** The app's sign-in, shared with the web view (empty if signed out). */
    static String cookie() {
        try {
            String c = CookieManager.getInstance().getCookie(BASE);
            return c == null ? "" : c;
        } catch (Throwable t) {
            return "";
        }
    }

    static synchronized void sync(Context ctx) throws Exception {
        String ck = cookie();
        if (ck.isEmpty()) return;
        String tz = URLEncoder.encode(TimeZone.getDefault().getID(), "UTF-8");
        HttpURLConnection c = (HttpURLConnection) new URL(BASE + "/api/calendar/reminders/upcoming?tz=" + tz).openConnection();
        c.setInstanceFollowRedirects(false);   // signed out = redirect to the sign-in page
        c.setConnectTimeout(15000);
        c.setReadTimeout(30000);
        c.setRequestProperty("Cookie", ck);
        c.setRequestProperty("Accept", "application/json");
        int code = c.getResponseCode();
        if (code != 200) { c.disconnect(); return; }
        String text = readAll(c.getInputStream());
        c.disconnect();
        JSONArray arr = new JSONObject(text).optJSONArray("reminders");
        if (arr == null) arr = new JSONArray();

        SharedPreferences sp = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        Set<String> oldCodes = new HashSet<>(sp.getStringSet("scheduled", new HashSet<>()));
        Set<String> shown = new HashSet<>(sp.getStringSet("shown", new HashSet<>()));
        AlarmManager am = (AlarmManager) ctx.getSystemService(Context.ALARM_SERVICE);
        long now = System.currentTimeMillis();
        Set<String> newCodes = new HashSet<>();
        Set<String> liveKeys = new HashSet<>();

        for (int i = 0; i < arr.length(); i++) {
            JSONObject r = arr.getJSONObject(i);
            String key = r.optString("key", "");
            if (key.isEmpty()) continue;
            long fireAt = r.optLong("fireAt", 0);
            long expiresAt = r.optLong("expiresAt", 0);
            liveKeys.add(key);
            String id = key + "|" + fireAt;
            if (shown.contains(id) || expiresAt <= now) continue;
            long when = Math.max(fireAt, now + 1500);   // already due: show it now
            int rc = id.hashCode();
            schedule(ctx, am, rc, when, key, id, r.optString("title", "Reminder"), r.optString("body", ""), expiresAt);
            newCodes.add(String.valueOf(rc));
        }

        // Alarms for reminders that were dismissed / moved / deleted elsewhere
        for (String s : oldCodes) {
            if (newCodes.contains(s)) continue;
            try {
                int rc = Integer.parseInt(s);
                PendingIntent pi = PendingIntent.getBroadcast(ctx, rc, showIntent(ctx, rc), PendingIntent.FLAG_NO_CREATE | PendingIntent.FLAG_IMMUTABLE);
                if (pi != null) { am.cancel(pi); pi.cancel(); }
            } catch (NumberFormatException ignored) {}
        }

        // A notification already on screen that was dismissed on another device goes away too
        NotificationManager nm = (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm != null && Build.VERSION.SDK_INT >= 23) {
            for (StatusBarNotification sbn : nm.getActiveNotifications()) {
                if (sbn.getId() == NOTIF_ID && sbn.getTag() != null && !liveKeys.contains(sbn.getTag())) nm.cancel(sbn.getTag(), NOTIF_ID);
            }
        }

        // Forget "already shown" marks for reminders that are over
        Set<String> keepShown = new HashSet<>();
        for (String id : shown) {
            int cut = id.lastIndexOf('|');
            if (cut > 0 && liveKeys.contains(id.substring(0, cut))) keepShown.add(id);
        }
        sp.edit().putStringSet("scheduled", newCodes).putStringSet("shown", keepShown).apply();
    }

    static Intent showIntent(Context ctx, int rc) {
        Intent i = new Intent(ctx, ReminderReceiver.class);
        i.setAction(ReminderReceiver.ACTION_SHOW);
        i.setData(Uri.parse("avenium-reminder://show/" + rc));   // one alarm per reminder
        return i;
    }

    static void schedule(Context ctx, AlarmManager am, int rc, long when, String key, String id, String title, String body, long expiresAt) {
        Intent i = showIntent(ctx, rc);
        i.putExtra("key", key);
        i.putExtra("id", id);
        i.putExtra("title", title);
        i.putExtra("body", body);
        i.putExtra("expiresAt", expiresAt);
        PendingIntent pi = PendingIntent.getBroadcast(ctx, rc, i, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        if (Build.VERSION.SDK_INT >= 31 && !am.canScheduleExactAlarms()) {
            am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, when, pi);
        } else if (Build.VERSION.SDK_INT >= 23) {
            am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, when, pi);
        } else {
            am.setExact(AlarmManager.RTC_WAKEUP, when, pi);
        }
    }

    /** Checks the server about every 15 minutes, so new events get their alarms too. */
    static void ensurePeriodic(Context ctx) {
        AlarmManager am = (AlarmManager) ctx.getSystemService(Context.ALARM_SERVICE);
        Intent i = new Intent(ctx, ReminderReceiver.class).setAction(ReminderReceiver.ACTION_SYNC);
        PendingIntent pi = PendingIntent.getBroadcast(ctx, PERIODIC_RC, i, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        am.setInexactRepeating(AlarmManager.RTC_WAKEUP, System.currentTimeMillis() + AlarmManager.INTERVAL_FIFTEEN_MINUTES,
                AlarmManager.INTERVAL_FIFTEEN_MINUTES, pi);
    }

    static void ensureChannel(Context ctx) {
        if (Build.VERSION.SDK_INT < 26) return;
        NotificationManager nm = (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null || nm.getNotificationChannel(CHANNEL) != null) return;
        NotificationChannel ch = new NotificationChannel(CHANNEL, "Reminders", NotificationManager.IMPORTANCE_HIGH);
        ch.setDescription("Meetings, appointments, birthdays and other occasions");
        ch.enableVibration(true);
        nm.createNotificationChannel(ch);
    }

    /** Dismiss (until = -1) or snooze (until = a time) on the server, so every device agrees. */
    static void postChoice(String key, long until) {
        String ck = cookie();
        if (ck.isEmpty()) return;
        HttpURLConnection c = null;
        try {
            JSONObject body = new JSONObject();
            body.put("keys", new JSONArray().put(key));
            body.put("until", until);
            byte[] bytes = body.toString().getBytes(StandardCharsets.UTF_8);
            c = (HttpURLConnection) new URL(BASE + "/api/calendar/reminders/dismiss").openConnection();
            c.setRequestMethod("POST");
            c.setDoOutput(true);
            c.setConnectTimeout(15000);
            c.setReadTimeout(20000);
            c.setRequestProperty("Cookie", ck);
            c.setRequestProperty("Content-Type", "application/json");
            try (OutputStream os = c.getOutputStream()) { os.write(bytes); }
            c.getResponseCode();
        } catch (Throwable ignored) {
        } finally {
            if (c != null) c.disconnect();
        }
    }

    private static String readAll(InputStream in) throws Exception {
        try (InputStream is = in; ByteArrayOutputStream out = new ByteArrayOutputStream()) {
            byte[] buf = new byte[8192];
            int n;
            while ((n = is.read(buf)) > 0) out.write(buf, 0, n);
            return out.toString("UTF-8");
        }
    }
}
