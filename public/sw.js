// Avenium Tasks — reminder notifications.
// The server sends a push when a meeting / appointment / birthday reminder is
// due; this shows it even when the site is closed. Snooze and Dismiss on the
// notification are saved to the server, so they apply on every device.

self.addEventListener("install", function () { self.skipWaiting(); });
self.addEventListener("activate", function (e) { e.waitUntil(self.clients.claim()); });

self.addEventListener("push", function (e) {
  var d = {};
  try { d = e.data ? e.data.json() : {}; } catch (err) { d = { title: "Reminder", body: e.data ? e.data.text() : "" }; }
  var actions = d.occasion
    ? [{ action: "snooze240", title: "Snooze 4 hours" }, { action: "dismiss", title: "Dismiss" }]
    : [{ action: "snooze10", title: "Snooze 10 min" }, { action: "dismiss", title: "Dismiss" }];
  e.waitUntil(self.registration.showNotification(d.title || "Reminder", {
    body: d.body || "",
    tag: d.key || undefined,
    renotify: true,
    requireInteraction: true,          // stays on screen until you act on it, like Outlook
    icon: "/assets/notify-icon.png",
    badge: "/assets/notify-badge.png",
    data: { key: d.key, url: d.url || "/#calendar" },
    actions: actions
  }));
});

function saveChoice(key, until) {
  if (!key) return Promise.resolve();
  return fetch("/api/calendar/reminders/dismiss", {
    method: "POST", credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ keys: [key], until: until })
  }).catch(function () {});
}

self.addEventListener("notificationclick", function (e) {
  var n = e.notification, data = n.data || {};
  n.close();
  if (e.action === "dismiss") { e.waitUntil(saveChoice(data.key, -1)); return; }
  if (e.action === "snooze10") { e.waitUntil(saveChoice(data.key, Date.now() + 10 * 60000)); return; }
  if (e.action === "snooze240") { e.waitUntil(saveChoice(data.key, Date.now() + 240 * 60000)); return; }
  // Tapping the notification itself opens (or focuses) the calendar
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(function (list) {
    for (var i = 0; i < list.length; i++) {
      var c = list[i];
      if (c.url.indexOf(self.location.origin) === 0 && "focus" in c) { c.navigate && c.navigate(data.url).catch(function () {}); return c.focus(); }
    }
    return self.clients.openWindow(data.url);
  }));
});
