package com.avenium.taskmanager;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** Phone alarms are cleared when the phone restarts or the app updates: book them again. */
public class BootReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        String a = intent.getAction();
        if (!Intent.ACTION_BOOT_COMPLETED.equals(a) && !Intent.ACTION_MY_PACKAGE_REPLACED.equals(a)) return;
        final Context ctx = context.getApplicationContext();
        ReminderSync.ensurePeriodic(ctx);
        final PendingResult pr = goAsync();
        new Thread(() -> {
            try { ReminderSync.sync(ctx); } catch (Throwable ignored) {} finally { pr.finish(); }
        }).start();
    }
}
