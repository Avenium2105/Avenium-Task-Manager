package com.avenium.taskmanager;

import android.Manifest;
import android.app.AlarmManager;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;

import androidx.core.app.NotificationCompat;
import androidx.core.content.ContextCompat;

import java.util.HashSet;
import java.util.Set;

/** Shows a reminder when its alarm rings, and handles Snooze / Dismiss / periodic sync. */
public class ReminderReceiver extends BroadcastReceiver {
    static final String ACTION_SHOW = "com.avenium.taskmanager.REMINDER_SHOW";
    static final String ACTION_DISMISS = "com.avenium.taskmanager.REMINDER_DISMISS";
    static final String ACTION_SNOOZE = "com.avenium.taskmanager.REMINDER_SNOOZE";
    static final String ACTION_SYNC = "com.avenium.taskmanager.REMINDER_SYNC";
    static final long SNOOZE_MS = 10 * 60 * 1000L;

    @Override
    public void onReceive(Context context, Intent intent) {
        final Context ctx = context.getApplicationContext();
        String action = intent.getAction();
        if (action == null) return;
        switch (action) {
            case ACTION_SHOW:
                show(ctx, intent);
                break;
            case ACTION_DISMISS: {
                final String key = intent.getStringExtra("key");
                cancelShown(ctx, key);
                final PendingResult pr = goAsync();
                new Thread(() -> { try { ReminderSync.postChoice(key, -1); } finally { pr.finish(); } }).start();
                break;
            }
            case ACTION_SNOOZE: {
                final String key = intent.getStringExtra("key");
                cancelShown(ctx, key);
                final long until = System.currentTimeMillis() + SNOOZE_MS;
                // ring again here in 10 minutes even if the phone is offline...
                String id = key + "|" + until;
                int rc = id.hashCode();
                AlarmManager am = (AlarmManager) ctx.getSystemService(Context.ALARM_SERVICE);
                ReminderSync.schedule(ctx, am, rc, until, key, id, intent.getStringExtra("title"), intent.getStringExtra("body"),
                        Math.max(intent.getLongExtra("expiresAt", 0), until + 60000));
                SharedPreferences sp = ctx.getSharedPreferences(ReminderSync.PREFS, Context.MODE_PRIVATE);
                Set<String> codes = new HashSet<>(sp.getStringSet("scheduled", new HashSet<>()));
                codes.add(String.valueOf(rc));
                sp.edit().putStringSet("scheduled", codes).apply();
                // ...and tell the server, so the computer snoozes it too
                final PendingResult pr = goAsync();
                new Thread(() -> { try { ReminderSync.postChoice(key, until); } finally { pr.finish(); } }).start();
                break;
            }
            case ACTION_SYNC: {
                ReminderSync.ensurePeriodic(ctx);
                final PendingResult pr = goAsync();
                new Thread(() -> {
                    try { ReminderSync.sync(ctx); } catch (Throwable ignored) {} finally { pr.finish(); }
                }).start();
                break;
            }
            default:
                break;
        }
    }

    private static void cancelShown(Context ctx, String key) {
        NotificationManager nm = (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm != null && key != null) nm.cancel(key, ReminderSync.NOTIF_ID);
    }

    private static PendingIntent action(Context ctx, String action, Intent src, int rc) {
        Intent i = new Intent(ctx, ReminderReceiver.class).setAction(action);
        i.setData(Uri.parse("avenium-reminder://" + action.substring(action.lastIndexOf('.') + 1).toLowerCase() + "/" + rc));
        i.putExtra("key", src.getStringExtra("key"));
        i.putExtra("title", src.getStringExtra("title"));
        i.putExtra("body", src.getStringExtra("body"));
        i.putExtra("expiresAt", src.getLongExtra("expiresAt", 0));
        return PendingIntent.getBroadcast(ctx, rc, i, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    private static void show(Context ctx, Intent intent) {
        String key = intent.getStringExtra("key");
        String id = intent.getStringExtra("id");
        if (key == null || id == null) return;
        long now = System.currentTimeMillis();
        long expiresAt = intent.getLongExtra("expiresAt", 0);
        if (expiresAt > 0 && expiresAt <= now) return;

        // Never show the same reminder twice
        SharedPreferences sp = ctx.getSharedPreferences(ReminderSync.PREFS, Context.MODE_PRIVATE);
        Set<String> shown = new HashSet<>(sp.getStringSet("shown", new HashSet<>()));
        if (shown.contains(id)) return;
        shown.add(id);
        sp.edit().putStringSet("shown", shown).apply();

        if (Build.VERSION.SDK_INT >= 33 &&
                ContextCompat.checkSelfPermission(ctx, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) return;
        ReminderSync.ensureChannel(ctx);

        Intent open = new Intent(ctx, MainActivity.class);
        open.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        int rc = id.hashCode();
        PendingIntent openPi = PendingIntent.getActivity(ctx, rc, open, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        String title = intent.getStringExtra("title");
        String body = intent.getStringExtra("body");
        NotificationCompat.Builder b = new NotificationCompat.Builder(ctx, ReminderSync.CHANNEL)
                .setSmallIcon(R.drawable.ic_stat_notify)
                .setColor(0xFF3C5A46)
                .setContentTitle(title == null ? "Reminder" : title)
                .setContentText(body == null ? "" : body)
                .setStyle(new NotificationCompat.BigTextStyle().bigText(body == null ? "" : body))
                .setPriority(NotificationCompat.PRIORITY_HIGH)
                .setCategory(NotificationCompat.CATEGORY_REMINDER)
                .setDefaults(NotificationCompat.DEFAULT_ALL)
                .setAutoCancel(true)
                .setContentIntent(openPi)
                .addAction(0, "Snooze 10 min", action(ctx, ACTION_SNOOZE, intent, rc))
                .addAction(0, "Dismiss", action(ctx, ACTION_DISMISS, intent, rc));
        if (expiresAt > now) b.setTimeoutAfter(expiresAt - now);   // gone by itself once the meeting / day is over

        NotificationManager nm = (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm != null) nm.notify(key, ReminderSync.NOTIF_ID, b.build());
    }
}
