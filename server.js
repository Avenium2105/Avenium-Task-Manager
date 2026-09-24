// Avenium Task Manager — standalone server
// Express + Socket.IO app: multi-board task tracking with per-user private
// groups, assignees, a status pipeline, turn notifications, and optional
// email send/receive via SMTP + IMAP (Outlook / Microsoft 365 by default).

const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const http = require("http");
const express = require("express");
const session = require("express-session");
const bcrypt = require("bcryptjs");
const multer = require("multer");
const { Server } = require("socket.io");
const nodemailer = require("nodemailer");
const https = require("https");

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || __dirname;
const DATA_FILE = path.join(DATA_DIR, "data.json");
const USERS_FILE = path.join(DATA_DIR, "users.json");
const SECRET_FILE = path.join(DATA_DIR, ".session-secret");
const UPLOADS_DIR = path.join(DATA_DIR, "uploads");
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(UPLOADS_DIR, { recursive: true });
const PUBLIC_URL = process.env.PUBLIC_URL || "";

// ---- OAuth calendar config ----
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "";
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || "";
const MICROSOFT_CLIENT_ID = process.env.MICROSOFT_CLIENT_ID || "";
const MICROSOFT_CLIENT_SECRET = process.env.MICROSOFT_CLIENT_SECRET || "";
const MICROSOFT_TENANT_ID = process.env.MICROSOFT_TENANT_ID || "common";
const GOOGLE_REDIRECT = PUBLIC_URL + "/auth/google/callback";
const MICROSOFT_REDIRECT = PUBLIC_URL + "/auth/microsoft/callback";
const CALENDAR_ENABLED = !!(GOOGLE_CLIENT_ID && MICROSOFT_CLIENT_ID);

// ---- Claude assistant (optional — set ANTHROPIC_API_KEY to switch it on) ----
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "";
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-5-20250929";

const GROUP_COLORS = ["#3C5A46", "#C68A2E", "#7D6BAE", "#4C7A9E", "#B24A3C"];
const DEFAULT_GROUPS = ["Today", "This week", "Someday"];
const MAX_FILE_BYTES = 20 * 1024 * 1024; // 20MB per file

// ---- Calendar connection store (persisted to DATA_DIR/calendar-tokens.json) ----
// A user can connect any number of Google and Microsoft accounts. Each entry:
// { id, userId, provider: "google"|"microsoft", email, accessToken,
//   refreshToken, expiresAt (ISO) }
// Every lookup below requires BOTH the connection id AND the logged-in user's
// id to match, so one user can never read or use another user's connection.
const TOKENS_FILE = path.join(DATA_DIR, "calendar-tokens.json");
let calendarTokens = [];
try { calendarTokens = JSON.parse(fs.readFileSync(TOKENS_FILE, "utf8")); } catch (e) { calendarTokens = []; }
// connections saved before multi-account support had no id — give them one
if (calendarTokens.some((t) => !t.id)) {
  calendarTokens.forEach((t) => { if (!t.id) t.id = "cal" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8); });
  fs.writeFileSync(TOKENS_FILE, JSON.stringify(calendarTokens, null, 2));
}
function persistTokens() {
  fs.writeFile(TOKENS_FILE, JSON.stringify(calendarTokens, null, 2), () => {});
}
function listAccounts(userId) {
  return calendarTokens.filter((t) => t.userId === userId);
}
function getAccount(userId, accountId) {
  return calendarTokens.find((t) => t.id === accountId && t.userId === userId) || null;
}
function saveAccount(userId, provider, data) {
  // Reconnecting the same account (same provider + email) refreshes it in
  // place instead of creating a duplicate; a different account is added.
  const existing = data.email
    ? calendarTokens.find((t) => t.userId === userId && t.provider === provider && t.email && t.email.toLowerCase() === data.email.toLowerCase())
    : null;
  if (existing) {
    existing.accessToken = data.accessToken;
    if (data.refreshToken) existing.refreshToken = data.refreshToken;
    existing.expiresAt = data.expiresAt;
  } else {
    calendarTokens.push({ id: "cal" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8), userId, provider, ...data });
  }
  persistTokens();
}
function removeAccount(userId, accountId) {
  calendarTokens = calendarTokens.filter((t) => !(t.id === accountId && t.userId === userId));
  persistTokens();
}

// ---- Which calendars each user has switched OFF (persisted separately) ----
// Keyed "accountId|calendarId" (or "builtin|jewish"). Absent = visible, so a
// newly connected calendar shows by default and only explicit hides are stored.
const CAL_PREFS_FILE = path.join(DATA_DIR, "calendar-prefs.json");
let calendarPrefs = {};
try { calendarPrefs = JSON.parse(fs.readFileSync(CAL_PREFS_FILE, "utf8")); } catch (e) { calendarPrefs = {}; }
function persistCalPrefs() {
  fs.writeFile(CAL_PREFS_FILE, JSON.stringify(calendarPrefs, null, 2), () => {});
}
function hiddenSet(userId) {
  return new Set((calendarPrefs[userId] && calendarPrefs[userId].hidden) || []);
}
function setCalendarVisible(userId, key, visible) {
  if (!calendarPrefs[userId]) calendarPrefs[userId] = { hidden: [] };
  const hidden = new Set(calendarPrefs[userId].hidden || []);
  if (visible) hidden.delete(key); else hidden.add(key);
  calendarPrefs[userId].hidden = [...hidden];
  persistCalPrefs();
}
function getShowHebrew(userId) {
  return calendarPrefs[userId] && calendarPrefs[userId].showHebrew !== undefined ? calendarPrefs[userId].showHebrew : false;
}
function setShowHebrew(userId, show) {
  if (!calendarPrefs[userId]) calendarPrefs[userId] = { hidden: [] };
  calendarPrefs[userId].showHebrew = !!show;
  persistCalPrefs();
}

// ---- Built-in calendars (no sign-in needed) ----
// Both are on by default — only calendars a user explicitly unticks are stored.
const BUILTIN_CALENDARS = [
  { id: "jewish", name: "Jewish Holidays", color: "#7D6BAE" },
  { id: "parsha", name: "Torah Portion", color: "#2E8B77" },
  { id: "usa", name: "US Holidays", color: "#4C7A9E" }
];

// ---- Local (app-native) events ----
// Stored on disk, no Google/Outlook needed. Each user gets their own set.
// Recurring events are stored once; expansion happens at read time.
const LOCAL_EVENTS_FILE = path.join(DATA_DIR, "local-events.json");
let localEvents = [];
try { localEvents = JSON.parse(fs.readFileSync(LOCAL_EVENTS_FILE, "utf8")); } catch (e) { localEvents = []; }
function persistLocalEvents() {
  fs.writeFile(LOCAL_EVENTS_FILE, JSON.stringify(localEvents, null, 2), () => {});
}

// ---- Hebrew date conversion ----
// Uses the browser/Node built-in Intl.DateTimeFormat with the Hebrew calendar,
// which is accurate and maintained by ICU — no hand-rolled arithmetic needed.
const _hebFmt = new Intl.DateTimeFormat("en-u-ca-hebrew", { day: "numeric", month: "long", year: "numeric" });

function gregorianToHebrew(gyear, gmonth, gday) {
  const d = new Date(gyear, gmonth - 1, gday, 12);
  const parts = _hebFmt.formatToParts(d);
  const obj = {};
  parts.forEach((p) => { obj[p.type] = p.value; });
  return { year: Number(obj.year), month: 0, day: Number(obj.day), monthName: obj.month || "" };
}

// Convert a Hebrew date to Gregorian by searching from an estimate.
// Used for Jewish recurrence: given a Hebrew month+day, find the
// Gregorian date in a specific Hebrew year.
function hebrewToGregorian(hYear, hMonthName, hDay) {
  // Hebrew year N starts in Sept/Oct of Gregorian year N-3761.
  // Tishrei–Adar fall in that Sept–Mar window; Nisan–Elul fall in the following Mar–Sept.
  var gYearEst = hYear - 3761;
  var monthOrder = ["Tishri", "Heshvan", "Kislev", "Tevet", "Shevat", "Adar", "Adar I", "Adar II", "Nisan", "Iyar", "Sivan", "Tamuz", "Av", "Elul"];
  var mIdx = monthOrder.indexOf(hMonthName);
  if (mIdx < 0) return null;
  // Rough Gregorian month: Tishri=Sept, Heshvan=Oct, ... Nisan=Mar(+1y), Iyar=Apr(+1y), etc.
  var gMonthEst, gYearAdj = gYearEst;
  if (mIdx <= 5) {
    // Tishri(0)=Sep, Heshvan(1)=Oct, Kislev(2)=Nov, Tevet(3)=Dec, Shevat(4)=Jan+1, Adar(5)=Feb+1
    gMonthEst = 8 + mIdx; // 0-indexed: 8=Sept
    if (gMonthEst >= 12) { gMonthEst -= 12; gYearAdj++; }
  } else if (mIdx <= 7) {
    // Adar I(6)=Feb+1, Adar II(7)=Mar+1
    gMonthEst = mIdx - 5; // 1=Feb, 2=Mar
    gYearAdj++;
  } else {
    // Nisan(8)=Mar+1, Iyar(9)=Apr+1, ... Elul(13)=Aug+1
    gMonthEst = mIdx - 6; // 2=Mar, 3=Apr, ... 7=Aug
    gYearAdj++;
  }
  var startSearch = new Date(gYearAdj, gMonthEst, 1);
  startSearch.setDate(startSearch.getDate() - 30); // back up generously for leap year shifts
  for (var i = 0; i < 90; i++) {
    var test = new Date(startSearch);
    test.setDate(test.getDate() + i);
    var heb = gregorianToHebrew(test.getFullYear(), test.getMonth() + 1, test.getDate());
    if (heb.day === hDay && heb.monthName === hMonthName && heb.year === hYear) {
      return { year: test.getFullYear(), month: test.getMonth() + 1, day: test.getDate() };
    }
  }
  return null;
}

// Like hebrewToGregorian, but handles Adar across leap/non-leap years:
// "Adar" in a leap year falls on Adar II (the customary choice for
// birthdays and anniversaries); "Adar I"/"Adar II" in a normal year falls on
// Adar. Returns { year, month, day, monthUsed } or null.
function hebrewToGregorianFlex(hYear, hMonthName, hDay) {
  var tries = [hMonthName];
  if (hMonthName === "Adar") tries.push("Adar II");
  if (hMonthName === "Adar I" || hMonthName === "Adar II") tries.push("Adar");
  for (var i = 0; i < tries.length; i++) {
    var g = hebrewToGregorian(hYear, tries[i], hDay);
    if (g) return { year: g.year, month: g.month, day: g.day, monthUsed: tries[i] };
  }
  return null;
}
function gregKey(g) { return g.year + "-" + String(g.month).padStart(2, "0") + "-" + String(g.day).padStart(2, "0"); }
// First date of a Jewish series ("YYYY-MM-DD"), from its Hebrew start date.
// Older events saved without a Hebrew year fall back to their start date.
function jewishSeriesFirstDate(ev) {
  if (ev.hebrewYear && ev.hebrewDay) {
    var g = hebrewToGregorianFlex(Number(ev.hebrewYear), ev.hebrewMonth || "Tishri", Number(ev.hebrewDay));
    if (g) return gregKey(g);
  }
  return String(ev.start || "").slice(0, 10);
}

// Expand a single local event into all its occurrences within a date range
function expandLocalEvent(ev, startDate, endDate) {
  if (!ev.repeat || ev.repeat === "none") {
    var evDate = (ev.allDay ? ev.start : ev.start).slice(0, 10);
    if (evDate >= startDate && evDate <= endDate) return [ev];
    return [];
  }
  var results = [];
  var until = ev.repeatUntil || endDate;
  if (until < startDate) return [];

  if (ev.repeat === "jewish-yearly" || ev.repeat === "jewish-monthly") {
    // Use the explicitly stored Hebrew date if available, otherwise derive from start date
    var hebDay, hebMonthName;
    if (ev.hebrewDay) {
      hebDay = ev.hebrewDay;
      hebMonthName = ev.hebrewMonth || null; // null for monthly (repeats every month)
    } else {
      var origDate = new Date(ev.start.slice(0, 10) + "T12:00:00");
      var heb = gregorianToHebrew(origDate.getFullYear(), origDate.getMonth() + 1, origDate.getDate());
      hebDay = heb.day;
      hebMonthName = heb.monthName;
    }
    // Never produce anything before the series' first date (used to run back
    // to the start of whatever range was asked for — e.g. 1900 for search).
    var firstDate = jewishSeriesFirstDate(ev);
    if (firstDate > startDate) startDate = firstDate;
    if (startDate > endDate || startDate > until) return [];
    var startY = parseInt(startDate.slice(0, 4));
    var endY = parseInt(endDate.slice(0, 4));
    // Estimate starting Hebrew year from the Gregorian range
    var approxHebStart = startY + 3760;

    if (ev.repeat === "jewish-yearly") {
      var searchMonth = hebMonthName || "Tishri";
      for (var hy = approxHebStart - 1; hy <= approxHebStart + (endY - startY) + 2; hy++) {
        var greg = hebrewToGregorianFlex(hy, searchMonth, hebDay);
        if (!greg) continue;
        var d = greg.year + "-" + String(greg.month).padStart(2, "0") + "-" + String(greg.day).padStart(2, "0");
        if (d >= startDate && d >= firstDate && d <= endDate && d <= until) {
          results.push({ ...ev, start: d, end: d, _instanceDate: d, seriesStart: firstDate });
        }
      }
    } else {
      // jewish-monthly: same day of every Hebrew month
      var MONTH_NAMES = ["Tishri", "Heshvan", "Kislev", "Tevet", "Shevat", "Adar", "Adar I", "Adar II", "Nisan", "Iyar", "Sivan", "Tamuz", "Av", "Elul"];
      for (var hy2 = approxHebStart - 1; hy2 <= approxHebStart + (endY - startY) + 2; hy2++) {
        for (var mi = 0; mi < MONTH_NAMES.length; mi++) {
          var greg2 = hebrewToGregorian(hy2, MONTH_NAMES[mi], hebDay);
          if (!greg2) continue;
          var d2 = greg2.year + "-" + String(greg2.month).padStart(2, "0") + "-" + String(greg2.day).padStart(2, "0");
          if (d2 >= startDate && d2 <= endDate && d2 <= until && d2 >= firstDate) {
            results.push({ ...ev, start: d2, end: d2, _instanceDate: d2, seriesStart: firstDate });
          }
        }
      }
    }
    return results;
  }

  // Secular recurrence: daily, weekly, monthly, yearly
  var cur = new Date(ev.start.slice(0, 10) + "T12:00:00");
  var maxIter = 20000;
  while (maxIter-- > 0) {
    var key = cur.getFullYear() + "-" + String(cur.getMonth() + 1).padStart(2, "0") + "-" + String(cur.getDate()).padStart(2, "0");
    if (key > until) break;
    if (key >= startDate && key <= endDate) {
      if (ev.allDay) {
        results.push({ ...ev, start: key, end: key, _instanceDate: key });
      } else {
        var origStart = new Date(ev.start);
        var origEnd = ev.end ? new Date(ev.end) : null;
        var diff = origEnd ? (origEnd - origStart) : 3600000;
        var instStart = new Date(cur);
        instStart.setHours(origStart.getHours(), origStart.getMinutes(), 0, 0);
        var instEnd = new Date(instStart.getTime() + diff);
        results.push({ ...ev, start: instStart.toISOString(), end: instEnd.toISOString(), _instanceDate: key });
      }
    }
    if (ev.repeat === "daily") cur.setDate(cur.getDate() + 1);
    else if (ev.repeat === "weekly") cur.setDate(cur.getDate() + 7);
    else if (ev.repeat === "monthly") cur.setMonth(cur.getMonth() + 1);
    else if (ev.repeat === "yearly") cur.setFullYear(cur.getFullYear() + 1);
    else break;
  }
  return results;
}

// Jewish holidays come from Hebcal's free public API — no account or key.
// Major + minor holidays, fast days and special Shabbatot, diaspora dates.
// Titles only: Hebcal's "memo" descriptions are deliberately dropped.
async function fetchJewishHolidays(timeMin, timeMax) {
  const start = String(timeMin).slice(0, 10);
  const end = String(timeMax).slice(0, 10);
  const r = await httpsRequest({
    hostname: "www.hebcal.com",
    path: `/hebcal?v=1&cfg=json&maj=on&min=on&mod=on&nx=on&ss=on&mf=on&c=off&s=off&start=${start}&end=${end}`,
    method: "GET",
    headers: { Accept: "application/json", "User-Agent": "AveniumTasks/1.0" }
  });
  if (!r.body || !r.body.items) return [];
  return r.body.items
    .filter((it) => it.category === "holiday" || it.category === "roshchodesh" || it.category === "fast")
    .map((it) => ({
      externalId: "hebcal_" + it.date + "_" + (it.title || "").replace(/\W+/g, ""),
      title: it.title || "", start: String(it.date).slice(0, 10), end: String(it.date).slice(0, 10),
      allDay: true, description: "", htmlLink: ""
    }));
}

// The weekly Torah portion (parsha) for each Shabbos, also from Hebcal.
// s=on asks for the sedrot; diaspora reading schedule.
async function fetchParsha(timeMin, timeMax) {
  const start = String(timeMin).slice(0, 10);
  const end = String(timeMax).slice(0, 10);
  const r = await httpsRequest({
    hostname: "www.hebcal.com",
    path: `/hebcal?v=1&cfg=json&s=on&maj=off&min=off&mod=off&nx=off&ss=off&mf=off&c=off&start=${start}&end=${end}`,
    method: "GET",
    headers: { Accept: "application/json", "User-Agent": "AveniumTasks/1.0" }
  });
  if (!r.body || !r.body.items) return [];
  return r.body.items
    .filter((it) => it.category === "parashat")
    .map((it) => ({
      externalId: "parsha_" + it.date,
      title: it.title || "", start: String(it.date).slice(0, 10), end: String(it.date).slice(0, 10),
      allDay: true, description: "", htmlLink: ""
    }));
}

// US public holidays from Nager.Date's free public API — no account or key.
// It answers per calendar year, so a range spanning a new year fetches both.
async function fetchUSHolidays(timeMin, timeMax) {
  const startDate = String(timeMin).slice(0, 10);
  const endDate = String(timeMax).slice(0, 10);
  const years = [];
  for (let y = Number(startDate.slice(0, 4)); y <= Number(endDate.slice(0, 4)); y++) years.push(y);
  const perYear = await Promise.all(years.map(async (y) => {
    try {
      const r = await httpsRequest({
        hostname: "date.nager.at", path: `/api/v3/PublicHolidays/${y}/US`, method: "GET",
        headers: { Accept: "application/json", "User-Agent": "AveniumTasks/1.0" }
      });
      return Array.isArray(r.body) ? r.body : [];
    } catch (e) { return []; }
  }));
  const seen = new Set();
  return perYear.flat()
    .filter((h) => h.date >= startDate && h.date <= endDate)
    .map((h) => ({
      externalId: "usholiday_" + h.date + "_" + String(h.name || "").replace(/\W+/g, ""),
      title: h.localName || h.name || "", start: h.date, end: h.date,
      allDay: true, description: "", htmlLink: ""
    }))
    // Nager repeats a holiday once per state/county variant (that's why
    // Columbus Day appeared twice) — keep one entry per day + name.
    .filter((ev) => {
      const key = ev.start + "|" + ev.title.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

async function fetchBuiltinEvents(id, timeMin, timeMax) {
  if (id === "jewish") return fetchJewishHolidays(timeMin, timeMax);
  if (id === "parsha") return fetchParsha(timeMin, timeMax);
  if (id === "usa") return fetchUSHolidays(timeMin, timeMax);
  return [];
}

// ---- Small in-memory cache for calendar reads ----
// Calendar data is read constantly (every month you flick through) but changes
// rarely, so each result is held briefly. `inflight` also means ten parallel
// requests for the same thing make ONE call instead of ten.
const calCache = new Map();    // key -> { value, expires }
const calInflight = new Map(); // key -> Promise
function cachedFetch(key, ttlMs, fn) {
  const hit = calCache.get(key);
  if (hit && hit.expires > Date.now()) return Promise.resolve(hit.value);
  if (calInflight.has(key)) return calInflight.get(key);
  const p = Promise.resolve()
    .then(fn)
    .then((value) => {
      calCache.set(key, { value, expires: Date.now() + ttlMs });
      calInflight.delete(key);
      return value;
    })
    .catch((err) => { calInflight.delete(key); throw err; });
  calInflight.set(key, p);
  return p;
}
function invalidateCalendarCache(prefix) {
  for (const k of calCache.keys()) if (k.startsWith(prefix)) calCache.delete(k);
}
// keep the map from growing forever
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of calCache) if (v.expires < now) calCache.delete(k);
}, 10 * 60 * 1000).unref();

// ---- Generic HTTPS helper (no npm dependency needed) ----
function httpsRequest(options, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (c) => { data += c; });
      res.on("end", () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data), headers: res.headers }); }
        catch (e) { resolve({ status: res.statusCode, body: data, headers: res.headers }); }
      });
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

// ---- Token refresh helpers ----
async function refreshGoogleToken(token) {
  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    client_secret: GOOGLE_CLIENT_SECRET,
    refresh_token: token.refreshToken,
    grant_type: "refresh_token"
  }).toString();
  const r = await httpsRequest({
    hostname: "oauth2.googleapis.com", path: "/token", method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "Content-Length": Buffer.byteLength(params) }
  }, params);
  if (r.body.access_token) {
    token.accessToken = r.body.access_token;
    token.expiresAt = new Date(Date.now() + (r.body.expires_in || 3600) * 1000).toISOString();
    persistTokens();
  }
  return token;
}

async function refreshMicrosoftToken(token) {
  const params = new URLSearchParams({
    client_id: MICROSOFT_CLIENT_ID,
    client_secret: MICROSOFT_CLIENT_SECRET,
    refresh_token: token.refreshToken,
    grant_type: "refresh_token",
    scope: "Calendars.ReadWrite offline_access"
  }).toString();
  const r = await httpsRequest({
    hostname: "login.microsoftonline.com",
    path: `/${MICROSOFT_TENANT_ID}/oauth2/v2.0/token`,
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "Content-Length": Buffer.byteLength(params) }
  }, params);
  if (r.body.access_token) {
    token.accessToken = r.body.access_token;
    if (r.body.refresh_token) token.refreshToken = r.body.refresh_token;
    token.expiresAt = new Date(Date.now() + (r.body.expires_in || 3600) * 1000).toISOString();
    persistTokens();
  }
  return token;
}

async function freshToken(account) {
  if (!account) return null;
  if (!account.expiresAt || new Date(account.expiresAt) < new Date(Date.now() + 60000)) {
    return account.provider === "google" ? refreshGoogleToken(account) : refreshMicrosoftToken(account);
  }
  return account;
}

// Microsoft returns times like "2026-09-22T13:00:00.0000000" in UTC (we ask
// for UTC below) with no timezone marker — add the "Z" so browsers read it as UTC.
function msTime(s) {
  if (!s) return s;
  return /([zZ]|[+-]\d\d:\d\d)$/.test(s) ? s : s.replace(/\.\d+$/, "") + "Z";
}
// Browsers send ISO times ending in "Z"; Graph wants them without it (timeZone given separately).
function msInputTime(s) { return String(s || "").replace(/\.\d+Z$/, "").replace(/Z$/, ""); }

// ---- Provider request pacing ----
// Outlook allows only ~4 simultaneous requests per mailbox and Google
// throttles bursts. Searching every calendar at once used to blow past that;
// the throttled account then quietly returned nothing. Every provider call
// now goes through a per-account queue and retries when throttled.
const reqLimiters = new Map();
function limited(key, max, fn) {
  let l = reqLimiters.get(key);
  if (!l) { l = { active: 0, q: [] }; reqLimiters.set(key, l); }
  return new Promise((resolve, reject) => {
    const run = () => {
      l.active++;
      Promise.resolve().then(fn).then(resolve, reject).finally(() => {
        l.active--;
        const next = l.q.shift();
        if (next) next(); else if (!l.active) reqLimiters.delete(key);
      });
    };
    if (l.active < max) run(); else l.q.push(run);
  });
}
function isThrottled(r) {
  if (r.status === 429 || r.status === 503 || r.status === 504) return true;
  if (r.status === 403) { const t = JSON.stringify(r.body || ""); return /rateLimit|RateLimit|quota/i.test(t); }
  return false;
}
async function requestWithRetry(send) {
  for (let attempt = 0; ; attempt++) {
    const r = await send();
    if (!isThrottled(r) || attempt >= 5) return r;
    const ra = r.headers && parseInt(r.headers["retry-after"], 10);
    const wait = ra > 0 ? Math.min(ra, 30) * 1000 : 500 * Math.pow(2, attempt);
    await new Promise((res) => setTimeout(res, wait));
  }
}
// Turn a provider failure into a readable error instead of "no events"
function providerError(provider, r) {
  const b = r.body || {};
  const msg = (b.error && (b.error.message || b.error.code || (typeof b.error === "string" ? b.error : ""))) || "";
  return new Error(provider + " " + r.status + (msg ? " — " + String(msg).slice(0, 140) : ""));
}
async function mapLimit(items, max, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(max, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); }
  }));
  return out;
}

// ---- Google Calendar API calls ----
async function googleApiRequest(accessToken, method, path2, body) {
  const bodyStr = body ? JSON.stringify(body) : null;
  const headers = { Authorization: "Bearer " + accessToken, Accept: "application/json" };
  if (bodyStr) { headers["Content-Type"] = "application/json"; headers["Content-Length"] = Buffer.byteLength(bodyStr); }
  return limited("google:" + accessToken, 6, () =>
    requestWithRetry(() => httpsRequest({ hostname: "www.googleapis.com", path: path2, method, headers }, bodyStr)));
}

async function listGoogleCalendars(account) {
  const r = await googleApiRequest(account.accessToken, "GET", "/calendar/v3/users/me/calendarList");
  if (!r.body || !r.body.items) throw new Error("google_calendar_list_failed");
  // "selected" = the calendars the person has switched on in Google Calendar itself
  return r.body.items.filter((c) => c.selected !== false || c.primary).map((c) => ({
    id: c.id, name: c.summaryOverride || c.summary || c.id, color: c.backgroundColor || "#1a73e8",
    canEdit: c.accessRole === "owner" || c.accessRole === "writer", primary: !!c.primary
  }));
}

async function fetchGoogleCalendarEvents(account, cal, timeMin, timeMax) {
  // Page through EVERY result. Google caps one page at 2500 and used to be
  // asked for 250 with no paging, which silently dropped everything past the
  // oldest 250 events on wide ranges (search, agenda "All time").
  const out = [];
  let pageToken = "";
  for (let page = 0; page < 200; page++) {
    const r = await googleApiRequest(account.accessToken, "GET",
      `/calendar/v3/calendars/${encodeURIComponent(cal.id)}/events?timeMin=${encodeURIComponent(timeMin)}&timeMax=${encodeURIComponent(timeMax)}&singleEvents=true&orderBy=startTime&maxResults=2500` +
      (pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : "") +
      // only the fields actually used — smaller payloads come back faster
      `&fields=${encodeURIComponent("nextPageToken,items(id,summary,start,end,description,location,htmlLink,attendees/email)")}`);
    if (r.status >= 400) throw providerError("Google", r);
    if (!r.body || !r.body.items) break;
    r.body.items.forEach((e) => out.push({
      externalId: e.id, title: e.summary || "(No title)",
      start: e.start && (e.start.dateTime || e.start.date),
      end: e.end && (e.end.dateTime || e.end.date),
      allDay: !!(e.start && e.start.date),
      description: e.description || "", htmlLink: e.htmlLink || "",
      location: e.location || "",
      attendees: (e.attendees || []).map((a) => a.email).filter(Boolean)
    }));
    pageToken = r.body.nextPageToken;
    if (!pageToken) break;
  }
  return out;
}

function googleEventBody(event) {
  const body = {
    summary: event.title,
    description: event.description || "",
    location: event.location || ""
  };
  if (event.allDay) {
    // Google all-day events use plain dates, and the end date is exclusive
    const startDate = String(event.start).slice(0, 10);
    const endDate = String(event.end || event.start).slice(0, 10);
    const endExclusive = new Date(endDate + "T00:00:00Z");
    endExclusive.setUTCDate(endExclusive.getUTCDate() + 1);
    body.start = { date: startDate };
    body.end = { date: endExclusive.toISOString().slice(0, 10) };
  } else {
    body.start = { dateTime: event.start, timeZone: "UTC" };
    body.end = { dateTime: event.end || event.start, timeZone: "UTC" };
  }
  if (Array.isArray(event.attendees) && event.attendees.length) {
    body.attendees = event.attendees.map((e) => ({ email: e }));
  }
  if (event.reminderMinutes != null) {
    body.reminders = { useDefault: false, overrides: [{ method: "popup", minutes: event.reminderMinutes }] };
  }
  const freq = { daily: "DAILY", weekly: "WEEKLY", monthly: "MONTHLY", yearly: "YEARLY" }[event.repeat];
  if (freq) {
    let rule = "RRULE:FREQ=" + freq;
    if (event.repeatUntil) rule += ";UNTIL=" + String(event.repeatUntil).replace(/-/g, "") + "T235959Z";
    body.recurrence = [rule];
  }
  return body;
}

// ---- Microsoft Graph Calendar API calls ----
async function graphRequest(accessToken, method, path2, body) {
  const bodyStr = body ? JSON.stringify(body) : null;
  const headers = { Authorization: "Bearer " + accessToken, Accept: "application/json", Prefer: 'outlook.timezone="UTC"' };
  if (bodyStr) { headers["Content-Type"] = "application/json"; headers["Content-Length"] = Buffer.byteLength(bodyStr); }
  return limited("microsoft:" + accessToken, 3, () =>
    requestWithRetry(() => httpsRequest({ hostname: "graph.microsoft.com", path: "/v1.0" + path2, method, headers }, bodyStr)));
}

async function listMicrosoftCalendars(account) {
  const r = await graphRequest(account.accessToken, "GET", "/me/calendars?$top=50");
  if (!r.body || !r.body.value) throw new Error("microsoft_calendar_list_failed");
  return r.body.value.map((c) => ({
    id: c.id, name: c.name || "Calendar",
    color: c.hexColor && c.hexColor !== "" ? c.hexColor : "#0078d4",
    canEdit: c.canEdit !== false, primary: !!c.isDefaultCalendar
  }));
}

// Exchange won't return one calendar view spanning decades, so a wide range
// is split into one-year windows (each paged). Outlook/Exchange calendars
// don't hold usable data before 1980, so wide ranges start there.
const MS_FLOOR = "1980-01-01T00:00:00.000Z";
async function fetchMicrosoftWindow(account, cal, timeMin, timeMax) {
  const out = [];
  let path2 = `/me/calendars/${encodeURIComponent(cal.id)}/calendarView?startDateTime=${encodeURIComponent(timeMin)}&endDateTime=${encodeURIComponent(timeMax)}&$top=250` +
    `&$select=${encodeURIComponent("id,subject,start,end,isAllDay,location,attendees,bodyPreview,webLink")}`;
  for (let page = 0; page < 500 && path2; page++) {
    const r = await graphRequest(account.accessToken, "GET", path2);
    if (r.status >= 400) throw providerError("Outlook", r);
    if (!r.body || !r.body.value) break;
    r.body.value.forEach((e) => out.push({
      externalId: e.id, title: e.subject || "(No title)",
      start: e.isAllDay ? (e.start && e.start.dateTime || "").slice(0, 10) : msTime(e.start && e.start.dateTime),
      end: e.isAllDay ? (e.end && e.end.dateTime || "").slice(0, 10) : msTime(e.end && e.end.dateTime),
      allDay: !!e.isAllDay,
      description: (e.bodyPreview) || "", htmlLink: e.webLink || "",
      location: (e.location && e.location.displayName) || "",
      attendees: (e.attendees || []).map((a) => a.emailAddress && a.emailAddress.address).filter(Boolean)
    }));
    const next = r.body["@odata.nextLink"];
    path2 = next ? next.replace(/^https:\/\/graph\.microsoft\.com\/v1\.0/, "") : "";
  }
  return out;
}
async function fetchMicrosoftCalendarEvents(account, cal, timeMin, timeMax) {
  let start = new Date(timeMin < MS_FLOOR ? MS_FLOOR : timeMin);
  const end = new Date(timeMax);
  if (!(start < end)) return [];
  const windows = [];
  while (start < end) {
    const next = new Date(start); next.setUTCFullYear(next.getUTCFullYear() + 1);
    const wEnd = next < end ? next : end;
    windows.push([start.toISOString(), wEnd.toISOString()]);
    start = wEnd;
  }
  const chunks = await mapLimit(windows, 3, (w) => fetchMicrosoftWindow(account, cal, w[0], w[1]));
  // an event crossing a window edge comes back twice — keep one
  const seen = new Set(), out = [];
  chunks.forEach((list) => list.forEach((ev) => {
    const k = ev.externalId + "|" + ev.start;
    if (!seen.has(k)) { seen.add(k); out.push(ev); }
  }));
  return out;
}

function microsoftEventBody(event) {
  const body = {
    subject: event.title,
    body: { contentType: "text", content: event.description || "" },
    isAllDay: !!event.allDay
  };
  if (event.location) body.location = { displayName: event.location };
  if (event.allDay) {
    // Graph all-day events must start/end at midnight, end date exclusive
    const startDate = String(event.start).slice(0, 10);
    const endDate = String(event.end || event.start).slice(0, 10);
    const endExclusive = new Date(endDate + "T00:00:00Z");
    endExclusive.setUTCDate(endExclusive.getUTCDate() + 1);
    body.start = { dateTime: startDate + "T00:00:00", timeZone: "UTC" };
    body.end = { dateTime: endExclusive.toISOString().slice(0, 10) + "T00:00:00", timeZone: "UTC" };
  } else {
    body.start = { dateTime: msInputTime(event.start), timeZone: "UTC" };
    body.end = { dateTime: msInputTime(event.end || event.start), timeZone: "UTC" };
  }
  if (Array.isArray(event.attendees) && event.attendees.length) {
    body.attendees = event.attendees.map((e) => ({ emailAddress: { address: e }, type: "required" }));
  }
  if (event.reminderMinutes != null) {
    body.isReminderOn = true;
    body.reminderMinutesBeforeStart = event.reminderMinutes;
  }
  const msType = { daily: "daily", weekly: "weekly", monthly: "absoluteMonthly", yearly: "absoluteYearly" }[event.repeat];
  if (msType) {
    const startDate = String(event.start).slice(0, 10);
    const d = new Date(startDate + "T00:00:00Z");
    const pattern = { type: msType, interval: 1 };
    if (msType === "weekly") {
      pattern.daysOfWeek = [["sunday","monday","tuesday","wednesday","thursday","friday","saturday"][d.getUTCDay()]];
    }
    if (msType === "absoluteMonthly") pattern.dayOfMonth = d.getUTCDate();
    if (msType === "absoluteYearly") { pattern.dayOfMonth = d.getUTCDate(); pattern.month = d.getUTCMonth() + 1; }
    body.recurrence = {
      pattern,
      range: event.repeatUntil
        ? { type: "endDate", startDate, endDate: String(event.repeatUntil).slice(0, 10) }
        : { type: "noEnd", startDate }
    };
  }
  return body;
}

async function listCalendarsFor(account) {
  // 5 minutes: adding/removing a calendar in Google/Outlook shows up soon,
  // but flicking between months doesn't re-ask every time.
  return cachedFetch("cals:" + account.id, 5 * 60 * 1000, () =>
    account.provider === "google" ? listGoogleCalendars(account) : listMicrosoftCalendars(account));
}

function uid(prefix) {
  return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}
function nowIso() { return new Date().toISOString(); }
// Capitalize the first letter of a task title (and after ". "/"! "/"? ")
// so titles read naturally without the user having to think about it.
function autoCapitalize(s) {
  return s.replace(/(^|[.!?]\s+)([a-z])/g, (m, sep, ch) => sep + ch.toUpperCase());
}

// ---------- session secret ----------

function loadOrCreateSecret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  if (fs.existsSync(SECRET_FILE)) return fs.readFileSync(SECRET_FILE, "utf8").trim();
  const secret = crypto.randomBytes(32).toString("hex");
  fs.writeFileSync(SECRET_FILE, secret);
  return secret;
}

// ---------- board state persistence ----------

function loadState() {
  const now = Date.now();
  const defaultBoard = { id: "b" + now, name: "General", order: 0, tabOrder: 0, createdAt: now, memberIds: null };

  if (fs.existsSync(DATA_FILE)) {
    try {
      const raw = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
      const boards = Array.isArray(raw.boards) && raw.boards.length ? raw.boards : [defaultBoard];
      const firstBoardId = boards[0].id;
      // memberIds === null/undefined means "open to everyone" — how every
      // board created before access control existed keeps working.
      boards.forEach((b) => { if (!("memberIds" in b)) b.memberIds = null; if (typeof b.tabOrder !== "number") b.tabOrder = b.order || 0; if (typeof b.private !== "boolean") b.private = false; });
      const groups = (Array.isArray(raw.groups) ? raw.groups : []).map((g) => ({
        visibility: "shared",
        boardId: firstBoardId,
        ...g
      }));
      const items = (Array.isArray(raw.items) ? raw.items : []).map((i) => {
        const migrated = {
          notes: "", assigneeIds: [], steps: [], archived: false, files: [],
          ...i
        };
        // migrate legacy single-assignee + status fields the first time we see them
        if (!Array.isArray(migrated.assigneeIds)) migrated.assigneeIds = [];
        if (migrated.assigneeId && !migrated.assigneeIds.includes(migrated.assigneeId)) migrated.assigneeIds.push(migrated.assigneeId);
        delete migrated.assigneeId;
        if (migrated.status === "done" && !migrated.archived) migrated.archived = true;
        delete migrated.status;
        delete migrated.dueDate;
        if (!Array.isArray(migrated.steps)) migrated.steps = [];
        // migrate the old typed step-log (next_step/completed_step/completed_task)
        // to the new persistent checklist model (each step has its own done flag)
        migrated.steps = migrated.steps.map((s) => {
          if (s && s.type) {
            if (s.type === "completed_task") return null; // handled via item.archived already
            return { id: s.id, text: s.text || "", done: s.type === "completed_step", byId: s.byId, byName: s.byName, createdAt: s.at, doneById: s.type === "completed_step" ? s.byId : undefined, doneByName: s.type === "completed_step" ? s.byName : undefined, doneAt: s.type === "completed_step" ? s.at : undefined };
          }
          return s;
        }).filter(Boolean);
        if (!Array.isArray(migrated.files)) migrated.files = [];
        // migrate the old single free-text "notes" field into the new multi-note
        // list, as that one note's starting entry — nothing is lost, and going
        // forward notesList is what the client actually reads/writes.
        if (!Array.isArray(migrated.notesList)) {
          migrated.notesList = migrated.notes && migrated.notes.trim()
            ? [{ id: uid("n"), text: migrated.notes, createdBy: migrated.createdBy, createdById: migrated.createdById, createdAt: migrated.createdAt || nowIso(), updatedBy: migrated.updatedBy, updatedById: migrated.updatedById, updatedAt: migrated.updatedAt || nowIso() }]
            : [];
        }
        return migrated;
      });
      return {
        boards, groups, items,
        activity: Array.isArray(raw.activity) ? raw.activity : [],
        messages: Array.isArray(raw.messages) ? raw.messages : [],
        // Personal/shared to-do list, separate from boards/tasks entirely. Private
        // to its creator by default — sharedWith (a list of user ids) is what
        // opens it up to show on someone else's list too.
        todos: Array.isArray(raw.todos) ? raw.todos : []
      };
    } catch (e) {
      console.error("Could not read data.json, starting fresh:", e.message);
    }
  }
  return {
    boards: [defaultBoard],
    groups: DEFAULT_GROUPS.map((name, i) => ({
      id: "g" + now + "_" + i,
      boardId: defaultBoard.id,
      name,
      color: GROUP_COLORS[i % GROUP_COLORS.length],
      order: i,
      visibility: "shared",
      createdAt: now
    })),
    items: [],
    activity: [],
    messages: [],
    todos: []
  };
}

let state = loadState();

let saveTimer = null;
function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.writeFile(DATA_FILE, JSON.stringify(state, null, 2), (err) => {
      if (err) console.error("Failed to save data.json:", err.message);
    });
  }, 150);
}

function logActivity(text) {
  state.activity.push({ id: uid("a"), text, at: nowIso() });
  if (state.activity.length > 200) state.activity = state.activity.slice(-200);
}

function groupById(id) { return state.groups.find((g) => g.id === id); }
function boardById(id) { return state.boards.find((b) => b.id === id); }
// null/undefined memberIds = open to everyone (legacy boards, and the default behavior
// unless the board has been deliberately restricted). Restricted boards — including
// private ones — require actual membership; admins get no automatic bypass, so a
// private board stays private even from other admins who aren't on it.
function canSeeBoard(board, user) {
  if (!board) return false;
  if (!board.memberIds) return true;
  return board.memberIds.includes(user.id);
}

// ---------- users ----------

function loadUsers() {
  if (fs.existsSync(USERS_FILE)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(USERS_FILE, "utf8"));
      if (Array.isArray(parsed) && parsed.length > 0) {
        return parsed.map((u) => ({ email: "", status: u.passwordHash ? "active" : "pending", ...u }));
      }
    } catch (e) {
      console.error("Could not read users.json:", e.message);
    }
  }
  return null;
}
function saveUsers() {
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
}

let users = loadUsers();
if (!users) {
  const tempPassword = crypto.randomBytes(4).toString("hex");
  users = [{
    id: uid("u"),
    username: "admin",
    displayName: "Admin",
    email: "",
    status: "active",
    passwordHash: bcrypt.hashSync(tempPassword, 10),
    role: "admin",
    createdAt: nowIso()
  }];
  saveUsers();
  console.log("=================================================");
  console.log(" First run: created an admin account.");
  console.log("   username: admin");
  console.log("   password: " + tempPassword);
  console.log(" Log in with this, then set your own email address");
  console.log(" from \"Manage users\", and invite your other users.");
  console.log("=================================================");
}

function findUserById(id) { return users.find((u) => u.id === id); }
function findUserByToken(token) { return token && users.find((u) => u.actionToken === token && u.actionTokenExpiresAt && new Date(u.actionTokenExpiresAt) > new Date()); }
function publicUser(u) {
  return { id: u.id, username: u.username || "", displayName: u.displayName || "", email: u.email || "", role: u.role, status: u.status || "active", createdAt: u.createdAt };
}
function teamMember(u) { return { id: u.id, displayName: u.displayName }; }
function activeUsers() { return users.filter((u) => u.status !== "pending"); }
function broadcastTeam() { io.emit("team", activeUsers().map(teamMember)); }

// Finish activating a pending (or password-resetting) account: apply the
// password they just set, and — for brand-new accounts — the username and
// display name they chose during setup (invites only collect an email now).
function activateUser(u) {
  const wasPending = u.status === "pending";
  u.passwordHash = u.pendingPasswordHash;
  if (u.pendingUsername) u.username = u.pendingUsername;
  if (u.pendingDisplayName) u.displayName = u.pendingDisplayName;
  u.status = "active";
  delete u.pendingPasswordHash; delete u.pendingUsername; delete u.pendingDisplayName;
  delete u.actionToken; delete u.actionTokenExpiresAt; delete u.mfaCode; delete u.mfaCodeExpiresAt;
  if (wasPending) logActivity(`${u.displayName || u.username || u.email} joined`);
}

function makeToken() { return crypto.randomBytes(24).toString("hex"); }
function makeCode() { return String(crypto.randomInt(100000, 999999)); }
function inviteLink(token) { return (PUBLIC_URL || "") + "/accept-invite.html?token=" + token; }

// Deep links for notification emails: land the person straight on the board
// (and, when there's a specific task, that task's panel) instead of just the
// bare app URL — the client (public/index.html) reads these query params on
// load and selects the right board/task automatically. Empty string when
// PUBLIC_URL isn't configured, same as the existing inviteLink behavior.
function boardLink(boardId) {
  if (!PUBLIC_URL || !boardId) return "";
  return PUBLIC_URL + "/?board=" + encodeURIComponent(boardId);
}
function itemLink(item) {
  if (!PUBLIC_URL || !item) return "";
  const group = groupById(item.groupId);
  if (!group) return "";
  return boardLink(group.boardId) + "&item=" + encodeURIComponent(item.id);
}

// ---------- email (optional — configured via environment variables) ----------
// Sending and receiving are independent: a relay like SMTP2GO only handles
// SENDING, so IMAP (for turning incoming mail into tasks) still needs its own
// direct login to the actual mailbox if you want that feature.

const SMTP_HOST = process.env.SMTP_HOST || "smtp.office365.com";
const SMTP_PORT = Number(process.env.SMTP_PORT || 587);
const SMTP_USER = process.env.SMTP_USER || process.env.EMAIL_USER || "";
const SMTP_PASS = process.env.SMTP_PASS || process.env.EMAIL_PASS || "";
const MAIL_FROM = process.env.MAIL_FROM || process.env.EMAIL_USER || SMTP_USER;
const EMAIL_SEND_ENABLED = !!(SMTP_USER && SMTP_PASS && MAIL_FROM);

const IMAP_HOST = process.env.IMAP_HOST || "outlook.office365.com";
const IMAP_PORT = Number(process.env.IMAP_PORT || 993);
const IMAP_USER = process.env.IMAP_USER || process.env.EMAIL_USER || "";
const IMAP_PASS = process.env.IMAP_PASS || process.env.EMAIL_PASS || "";
const EMAIL_RECEIVE_ENABLED = !!(IMAP_USER && IMAP_PASS) && process.env.EMAIL_RECEIVE !== "off";

let mailer = null;
if (EMAIL_SEND_ENABLED) {
  mailer = nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_PORT === 465,
    auth: { user: SMTP_USER, pass: SMTP_PASS }
  });
  console.log("Email sending is ON via " + SMTP_HOST + " as " + SMTP_USER + " (From: " + MAIL_FROM + ")");
} else {
  console.log("Email sending is OFF — set SMTP_USER/SMTP_PASS (or EMAIL_USER/EMAIL_PASS) to enable it.");
}

function sendMail(to, subject, text) {
  if (!mailer || !to) return Promise.resolve(false);
  return mailer.sendMail({ from: MAIL_FROM, to, subject, text })
    .then(() => true)
    .catch((e) => { console.error("Email send failed:", e.message); return false; });
}

function createTaskFromEmail(parsed) {
  const fromAddr = ((parsed.from && parsed.from.value && parsed.from.value[0] && parsed.from.value[0].address) || "").toLowerCase();
  const matchedUser = users.find((u) => (u.email || "").toLowerCase() === fromAddr);
  const targetBoard = state.boards[0];
  let group = state.groups.find((g) => g.boardId === targetBoard.id && g.name === "From email" && g.visibility !== "private");
  if (!group) {
    group = {
      id: uid("g"), boardId: targetBoard.id, name: "From email",
      color: GROUP_COLORS[4], order: state.groups.filter((g) => g.boardId === targetBoard.id).length,
      visibility: "shared", createdAt: Date.now(), createdBy: "Email"
    };
    state.groups.push(group);
  }
  const item = {
    id: uid("i"), groupId: group.id,
    title: (parsed.subject || "Untitled task").slice(0, 500),
    notes: (parsed.text || "").slice(0, 2000),
    priority: "low",
    assigneeIds: matchedUser ? [matchedUser.id] : [],
    steps: [], archived: false, files: [],
    order: state.items.filter((i) => i.groupId === group.id).length,
    createdAt: Date.now(), createdBy: "Email", updatedBy: "Email", updatedAt: nowIso()
  };
  state.items.push(item);
  logActivity(`New task "${item.title}" arrived by email` + (matchedUser ? ` and was assigned to ${matchedUser.displayName}` : ""));
  persist();
  broadcastState();
}

if (EMAIL_RECEIVE_ENABLED) {
  const { ImapFlow } = require("imapflow");
  const { simpleParser } = require("mailparser");

  async function pollInbox() {
    const client = new ImapFlow({
      host: IMAP_HOST, port: IMAP_PORT, secure: true,
      auth: { user: IMAP_USER, pass: IMAP_PASS }, logger: false
    });
    try {
      await client.connect();
      const lock = await client.getMailboxLock("INBOX");
      try {
        for await (const msg of client.fetch({ seen: false }, { source: true, uid: true })) {
          try {
            const parsed = await simpleParser(msg.source);
            createTaskFromEmail(parsed);
          } catch (e) {
            console.error("Could not parse an incoming email:", e.message);
          }
          await client.messageFlagsAdd(msg.uid, ["\\Seen"], { uid: true });
        }
      } finally {
        lock.release();
      }
      await client.logout();
    } catch (e) {
      console.error("IMAP check failed (will retry):", e.message);
    }
  }
  setInterval(pollInbox, 2 * 60 * 1000);
  pollInbox();
  console.log("Email receiving is ON via " + IMAP_HOST + " as " + IMAP_USER + " (checked every 2 minutes)");
} else {
  console.log("Email receiving is OFF — set IMAP_USER/IMAP_PASS to enable turning incoming mail into tasks.");
}

// ---------- app ----------

const app = express();
app.use(express.json());

const sessionMiddleware = session({
  secret: loadOrCreateSecret(),
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 1000 * 60 * 60 * 24 * 30 }
});
app.use(sessionMiddleware);

function requireAuth(req, res, next) {
  if (req.session && req.session.userId && findUserById(req.session.userId)) return next();
  if (req.path.startsWith("/api/")) return res.status(401).json({ error: "not_authenticated" });
  // Preserve the originally-requested URL (path + query, e.g. a notification
  // email's "?board=...&item=..." deep link) so it can be restored after
  // signing in, instead of always dropping back to the bare board list.
  return res.redirect("/login.html?next=" + encodeURIComponent(req.originalUrl));
}
function requireAdmin(req, res, next) {
  const u = req.session && findUserById(req.session.userId);
  if (u && u.role === "admin") return next();
  if (req.path.startsWith("/api/")) return res.status(403).json({ error: "forbidden" });
  return res.redirect("/");
}

// ---- static brand assets (logo etc. — public, needed on pre-auth pages too) ----
app.use("/assets", express.static(path.join(__dirname, "public", "assets")));

// (The nav bar used to be served as separate /nav.js and /nav.css files, fetched
// with their own <script src>/<link> tags. That's gone now — the nav bar is
// inlined directly into index.html's own <head>/<body>, so there's no longer a
// second request for it that could 404, get blocked, or serve a stale cached
// copy independently of the page around it. If you still have public/nav.js
// and public/nav.css sitting in the repo, they're unused now and safe to delete.)

// ---- pages ----
app.get("/login.html", (req, res) => res.sendFile(path.join(__dirname, "public", "login.html")));
app.get(["/", "/index.html"], requireAuth, (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));
// Admin is a client-side view inside index.html now, switched to via a URL
// hash ("/#admin") rather than a real path — a hash is never sent to the
// server as part of the request, so there's no separate route for it to
// take anymore; visiting "/" always serves the same file regardless of what
// (if anything) follows a "#" in the address bar, and the page's own script
// reads that hash after it loads to decide which view to show. The actual
// admin data stays protected the way it always has, via requireAuth +
// requireAdmin on the /api/users etc. endpoints below — a non-admin who
// somehow lands on the admin view client-side just sees an empty shell,
// since every request it makes for real data still gets rejected server-side.
// /admin and /users.html both redirect here (with the hash added) so any
// existing bookmarks still land in the right place instead of 404ing.
app.get(["/admin", "/users.html"], requireAuth, (req, res) => res.redirect("/#admin"));
app.get("/accept-invite.html", (req, res) => res.sendFile(path.join(__dirname, "public", "accept-invite.html")));

function isValidEmail(s) { return typeof s === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim()); }

// ---- auth API ----
app.post("/api/login", (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: "missing_fields" });
  const u = users.find((x) => x.username.toLowerCase() === String(username).toLowerCase());
  if (!u || u.status === "pending" || !u.passwordHash || !bcrypt.compareSync(password, u.passwordHash)) {
    return res.status(401).json({ error: "invalid_credentials" });
  }
  req.session.userId = u.id;
  res.json({ ok: true, user: publicUser(u) });
});
app.post("/api/logout", (req, res) => { req.session.destroy(() => res.json({ ok: true })); });
app.get("/api/me", requireAuth, (req, res) => res.json({ user: publicUser(findUserById(req.session.userId)) }));
app.get("/api/team", requireAuth, (req, res) => res.json({ team: users.filter((u) => u.status !== "pending").map(teamMember) }));

app.post("/api/change-password", requireAuth, (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  const u = findUserById(req.session.userId);
  if (!newPassword || String(newPassword).length < 6) return res.status(400).json({ error: "weak_password" });
  if (!bcrypt.compareSync(currentPassword || "", u.passwordHash)) return res.status(401).json({ error: "wrong_current_password" });
  u.passwordHash = bcrypt.hashSync(newPassword, 10);
  saveUsers();
  res.json({ ok: true });
});

// ---- invite / first-login MFA / password-reset API (public — protected by the token itself) ----

app.post("/api/invite/token-info", (req, res) => {
  const u = findUserByToken((req.body || {}).token);
  if (!u) return res.status(400).json({ error: "invalid_or_expired" });
  res.json({ ok: true, displayName: u.displayName || "", email: u.email || "", isNewAccount: u.status === "pending" });
});

app.post("/api/invite/set-password", async (req, res) => {
  const { token, password, username, displayName } = req.body || {};
  const u = findUserByToken(token);
  if (!u) return res.status(400).json({ error: "invalid_or_expired" });
  if (!password || String(password).length < 6) return res.status(400).json({ error: "weak_password" });

  const isNewAccount = u.status === "pending";
  if (isNewAccount) {
    // Invites now only collect an email — the person picks their own
    // username and display name here, as part of account setup.
    if (!username || !String(username).trim()) return res.status(400).json({ error: "username_required" });
    if (!displayName || !String(displayName).trim()) return res.status(400).json({ error: "display_name_required" });
    const uname = String(username).trim().slice(0, 60);
    if (users.some((x) => x.id !== u.id && (x.username || "").toLowerCase() === uname.toLowerCase())) {
      return res.status(409).json({ error: "username_taken" });
    }
    u.pendingUsername = uname;
    u.pendingDisplayName = String(displayName).trim().slice(0, 100);
  }
  u.pendingPasswordHash = bcrypt.hashSync(String(password), 10);

  if (EMAIL_SEND_ENABLED) {
    u.mfaCode = makeCode();
    u.mfaCodeExpiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    saveUsers();
    const sent = await sendMail(u.email, "Your verification code", `Your Avenium Task Manager verification code is ${u.mfaCode}. It expires in 10 minutes.`);
    // If actual delivery failed (e.g. the mailbox rejects SMTP auth), don't strand the
    // person with a code they can never receive — surface it directly as a fallback.
    return res.json({ ok: true, mfaRequired: true, emailed: sent, codeFallback: sent ? undefined : u.mfaCode });
  }

  // No email configured on the server — activate directly, no MFA possible.
  activateUser(u);
  saveUsers();
  req.session.userId = u.id;
  persist();
  broadcastTeam();
  res.json({ ok: true, mfaRequired: false });
});

app.post("/api/invite/verify-code", (req, res) => {
  const { token, code } = req.body || {};
  const u = findUserByToken(token);
  if (!u || !u.pendingPasswordHash) return res.status(400).json({ error: "invalid_or_expired" });
  if (!u.mfaCode || !u.mfaCodeExpiresAt || new Date(u.mfaCodeExpiresAt) < new Date()) return res.status(400).json({ error: "code_expired" });
  if (String(code || "").trim() !== u.mfaCode) return res.status(401).json({ error: "wrong_code" });

  activateUser(u);
  saveUsers();
  req.session.userId = u.id;
  persist();
  broadcastTeam();
  res.json({ ok: true });
});

app.post("/api/invite/resend-code", async (req, res) => {
  const { token } = req.body || {};
  const u = findUserByToken(token);
  if (!u || !u.pendingPasswordHash) return res.status(400).json({ error: "invalid_or_expired" });
  if (!EMAIL_SEND_ENABLED) return res.status(400).json({ error: "email_not_configured" });
  u.mfaCode = makeCode();
  u.mfaCodeExpiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  saveUsers();
  const sent = await sendMail(u.email, "Your verification code", `Your Avenium Task Manager verification code is ${u.mfaCode}. It expires in 10 minutes.`);
  res.json({ ok: true, emailed: sent, codeFallback: sent ? undefined : u.mfaCode });
});

// ---- user management API (admin only) ----
app.get("/api/users", requireAuth, requireAdmin, (req, res) => res.json({ users: users.map(publicUser) }));

app.post("/api/users", requireAuth, requireAdmin, async (req, res) => {
  const { email, role } = req.body || {};
  if (!isValidEmail(email)) return res.status(400).json({ error: "invalid_email" });
  if (users.some((u) => (u.email || "").toLowerCase() === String(email).trim().toLowerCase())) return res.status(409).json({ error: "email_taken" });

  // Invites only collect an email now — the invited person picks their own
  // username and display name when they open the link and set a password.
  const token = makeToken();
  const newUser = {
    id: uid("u"),
    username: "",
    displayName: "",
    email: String(email).trim().slice(0, 200),
    role: role === "admin" ? "admin" : "member",
    status: "pending",
    passwordHash: null,
    actionToken: token,
    actionTokenExpiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    createdAt: nowIso()
  };
  users.push(newUser);
  saveUsers();
  logActivity(`${findUserById(req.session.userId).displayName} invited ${newUser.email}`);
  persist();
  broadcastTeam();
  const link = inviteLink(token);
  const emailed = await sendMail(newUser.email, "You've been invited to Avenium Task Manager", `You've been invited to join Avenium Task Manager. Set up your account here:\n\n${link}\n\nThis link expires in 7 days.`);
  res.json({ ok: true, user: publicUser(newUser), inviteLink: link, emailed });
});

app.post("/api/users/:id/resend-invite", requireAuth, requireAdmin, async (req, res) => {
  const u = findUserById(req.params.id);
  if (!u) return res.status(404).json({ error: "not_found" });
  const token = makeToken();
  u.actionToken = token;
  u.actionTokenExpiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  saveUsers();
  const link = inviteLink(token);
  const emailed = await sendMail(u.email, "You've been invited to Avenium Task Manager", `You've been invited to join Avenium Task Manager. Set up your account here:\n\n${link}\n\nThis link expires in 7 days.`);
  res.json({ ok: true, inviteLink: link, emailed });
});

app.post("/api/users/:id/reset-password", requireAuth, requireAdmin, async (req, res) => {
  const u = findUserById(req.params.id);
  if (!u) return res.status(404).json({ error: "not_found" });
  const token = makeToken();
  u.actionToken = token;
  u.actionTokenExpiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  saveUsers();
  const link = inviteLink(token);
  const emailed = await sendMail(u.email, "Reset your Avenium Task Manager password", `Set a new password here:\n\n${link}\n\nThis link expires in 24 hours.`);
  res.json({ ok: true, inviteLink: link, emailed });
});

app.put("/api/users/:id", requireAuth, requireAdmin, (req, res) => {
  const u = findUserById(req.params.id);
  if (!u) return res.status(404).json({ error: "not_found" });
  const { displayName, email, role } = req.body || {};
  if (typeof displayName === "string") {
    if (!displayName.trim()) return res.status(400).json({ error: "display_name_required" });
    u.displayName = displayName.trim().slice(0, 100);
  }
  if (typeof email === "string") {
    if (!isValidEmail(email)) return res.status(400).json({ error: "invalid_email" });
    u.email = email.trim().slice(0, 200);
  }
  if (role === "admin" || role === "member") {
    if (u.role === "admin" && role !== "admin") {
      const adminCount = users.filter((x) => x.role === "admin").length;
      if (adminCount <= 1) return res.status(400).json({ error: "last_admin" });
    }
    u.role = role;
  }
  saveUsers();
  broadcastTeam();
  res.json({ ok: true, user: publicUser(u) });
});

app.delete("/api/users/:id", requireAuth, requireAdmin, (req, res) => {
  const target = findUserById(req.params.id);
  if (!target) return res.status(404).json({ error: "not_found" });
  if (target.id === req.session.userId) return res.status(400).json({ error: "cannot_delete_self" });
  if (target.role === "admin") {
    const adminCount = users.filter((x) => x.role === "admin").length;
    if (adminCount <= 1) return res.status(400).json({ error: "last_admin" });
  }
  users = users.filter((u) => u.id !== target.id);
  saveUsers();
  logActivity(`${findUserById(req.session.userId).displayName} removed the account "${target.username}"`);
  persist();
  broadcastTeam();
  res.json({ ok: true });
});


// ---- activity API ----
app.get("/api/activity", requireAuth, (req, res) => res.json({ activity: state.activity.slice(-60).reverse() }));

// ---- file attachments (stored on local disk under DATA_DIR/uploads/<itemId>/) ----
function itemUploadDir(itemId) { return path.join(UPLOADS_DIR, itemId); }
function removeItemUploads(itemId) {
  fs.rm(itemUploadDir(itemId), { recursive: true, force: true }, () => {});
}
function canAccessItem(item, user) {
  if (!item) return false;
  const group = groupById(item.groupId);
  if (!group) return false;
  if (group.visibility === "private" && group.ownerId !== user.id) return false;
  return canSeeBoard(boardById(group.boardId), user);
}

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const dir = itemUploadDir(req.params.id);
      fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (req, file, cb) => cb(null, uid("f") + "-" + file.originalname.replace(/[^a-zA-Z0-9._-]/g, "_").slice(-150))
  }),
  limits: { fileSize: MAX_FILE_BYTES }
});

app.post("/api/items/:id/files", requireAuth, (req, res) => {
  const item = state.items.find((x) => x.id === req.params.id);
  const user = findUserById(req.session.userId);
  if (!item || !canAccessItem(item, user)) return res.status(404).json({ error: "not_found" });
  upload.single("file")(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.code === "LIMIT_FILE_SIZE" ? "file_too_large" : "upload_failed" });
    if (!req.file) return res.status(400).json({ error: "no_file" });
    const record = {
      id: uid("file"), name: req.file.originalname.slice(0, 200), storedAs: req.file.filename,
      size: req.file.size, mime: req.file.mimetype || "application/octet-stream",
      uploadedBy: user.displayName || user.username, uploadedById: user.id, uploadedAt: nowIso()
    };
    item.files.push(record);
    item.updatedBy = user.displayName || user.username;
    item.updatedAt = nowIso();
    const group = groupById(item.groupId);
    if (group.visibility !== "private") logActivity(`${user.displayName || user.username} attached "${record.name}" to "${item.title}"`);
    persist();
    broadcastState();
    res.json({ ok: true, file: record });
  });
});

app.get("/api/items/:id/files/:fileId", requireAuth, (req, res) => {
  const item = state.items.find((x) => x.id === req.params.id);
  const user = findUserById(req.session.userId);
  if (!item || !canAccessItem(item, user)) return res.status(404).json({ error: "not_found" });
  const file = item.files.find((f) => f.id === req.params.fileId);
  if (!file) return res.status(404).json({ error: "not_found" });
  res.download(path.join(itemUploadDir(item.id), file.storedAs), file.name);
});

app.delete("/api/items/:id/files/:fileId", requireAuth, (req, res) => {
  const item = state.items.find((x) => x.id === req.params.id);
  const user = findUserById(req.session.userId);
  if (!item || !canAccessItem(item, user)) return res.status(404).json({ error: "not_found" });
  const file = item.files.find((f) => f.id === req.params.fileId);
  if (!file) return res.status(404).json({ error: "not_found" });
  item.files = item.files.filter((f) => f.id !== req.params.fileId);
  fs.unlink(path.join(itemUploadDir(item.id), file.storedAs), () => {});
  const group = groupById(item.groupId);
  if (group.visibility !== "private") logActivity(`${user.displayName || user.username} removed "${file.name}" from "${item.title}"`);
  persist();
  broadcastState();
  res.json({ ok: true });
});

// ---------- realtime board ----------

const server = http.createServer(app);
const io = new Server(server);
io.engine.use(sessionMiddleware);

function socketUser(socket) {
  const sess = socket.request.session;
  if (!sess || !sess.userId) return null;
  return findUserById(sess.userId);
}

// Build the state a specific user is allowed to see: every shared group/item,
// plus only that user's own private groups/items.
function stateForUser(userId) {
  const user = findUserById(userId);
  const visibleBoards = state.boards.filter((b) => canSeeBoard(b, user));
  const visibleBoardIds = new Set(visibleBoards.map((b) => b.id));
  const visibleGroups = state.groups.filter((g) => visibleBoardIds.has(g.boardId) && (g.visibility !== "private" || g.ownerId === userId));
  const visibleGroupIds = new Set(visibleGroups.map((g) => g.id));
  const visibleItems = state.items.filter((i) => visibleGroupIds.has(i.groupId));
  const visibleItemIds = new Set(visibleItems.map((i) => i.id));
  const visibleMessages = state.messages.filter((m) =>
    m.scope === "board" ? visibleBoardIds.has(m.scopeId) : visibleItemIds.has(m.scopeId)
  );
  // Same private-by-default idea as private groups: a to-do only shows up for its
  // creator, plus anyone specifically listed in sharedWith. This filtering happens
  // here (per-user, server-side) rather than client-side, so an unshared to-do
  // never even reaches another person's browser in the first place.
  const visibleTodos = state.todos.filter((t) =>
    (t.createdById === userId || (t.sharedWith || []).includes(userId)) &&
    !(t.removedBy || []).includes(userId)
  );
  return { boards: visibleBoards, groups: visibleGroups, items: visibleItems, activity: state.activity, messages: visibleMessages, todos: visibleTodos };
}

function broadcastState() {
  for (const [, socket] of io.sockets.sockets) {
    const user = socketUser(socket);
    if (!user) continue;
    socket.emit("state", stateForUser(user.id));
  }
}

io.on("connection", (socket) => {
  const user = socketUser(socket);
  if (!user) { socket.emit("auth_error"); socket.disconnect(true); return; }
  const actorName = () => user.displayName || user.username;

  function canTouchGroup(g) {
    if (!g) return false;
    if (g.visibility === "private" && g.ownerId !== user.id) return false;
    const board = boardById(g.boardId);
    return canSeeBoard(board, user);
  }

  socket.emit("state", stateForUser(user.id));
  socket.emit("me", publicUser(user));
  socket.emit("team", activeUsers().map(teamMember));

  // ---- boards ----
  socket.on("addBoard", ({ name, isPrivate }) => {
    if (!name || typeof name !== "string") return;
    const board = {
      id: uid("b"), name: autoCapitalize(name.trim().slice(0, 100)) || "Untitled board",
      order: state.boards.length, tabOrder: state.boards.length,
      createdAt: Date.now(), createdBy: actorName(), createdById: user.id,
      // Admins create boards open to everyone by default (matches how shared company
      // boards have always worked); anyone else's board starts private to just them,
      // until an admin grants access to others. Checking "Private" forces it private
      // regardless of role, and its creation is never announced to anyone else.
      memberIds: isPrivate ? [user.id] : (user.role === "admin" ? null : [user.id]),
      private: !!isPrivate
    };
    state.boards.push(board);
    if (!isPrivate) logActivity(`${actorName()} created the board "${board.name}"`);
    persist();
    broadcastState();
  });

  socket.on("updateBoardAccess", ({ id, memberIds, isPrivate }) => {
    if (user.role !== "admin") return;
    const board = boardById(id);
    if (!board) return;
    if (memberIds === null) {
      board.memberIds = null; // open to everyone
      board.private = false;
    } else if (Array.isArray(memberIds)) {
      const validIds = new Set(users.map((u) => u.id));
      const next = new Set(memberIds.filter((mid) => validIds.has(mid)));
      next.add(user.id); // never let the admin making this change lock themselves out
      board.memberIds = [...next].slice(0, 500);
      board.private = !!isPrivate;
    } else {
      return;
    }
    logActivity(`${actorName()} updated who can see the board "${board.name}"`);
    persist();
    broadcastState();
  });

  socket.on("updateBoard", ({ id, name }) => {
    if (user.role !== "admin") return;
    const board = state.boards.find((b) => b.id === id);
    if (!board || !name || typeof name !== "string" || !name.trim()) return;
    const oldName = board.name;
    board.name = autoCapitalize(name.trim().slice(0, 100));
    if (board.name !== oldName) logActivity(`${actorName()} renamed the board "${oldName}" to "${board.name}"`);
    persist();
    broadcastState();
  });

  socket.on("deleteBoard", ({ id }) => {
    if (user.role !== "admin") return;
    const board = state.boards.find((b) => b.id === id);
    if (!board) return;
    if (state.boards.length <= 1) return; // always keep at least one board
    const hasGroups = state.groups.some((g) => g.boardId === id);
    if (hasGroups) return; // only empty boards can be deleted
    state.boards = state.boards.filter((b) => b.id !== id);
    state.messages = state.messages.filter((m) => !(m.scope === "board" && m.scopeId === id));
    logActivity(`${actorName()} deleted the board "${board.name}"`);
    persist();
    broadcastState();
  });

  socket.on("swapBoardOrder", ({ idA, idB }) => {
    const a = boardById(idA);
    const b = boardById(idB);
    if (!a || !b || !canSeeBoard(a, user) || !canSeeBoard(b, user)) return;
    const tmp = a.order;
    a.order = b.order;
    b.order = tmp;
    persist();
    broadcastState();
  });

  // Separate from swapBoardOrder: this reorders the tabs at the top only,
  // independent of how boards are grouped/ordered in the "All boards" view.
  socket.on("swapBoardTabOrder", ({ idA, idB }) => {
    const a = boardById(idA);
    const b = boardById(idB);
    if (!a || !b || !canSeeBoard(a, user) || !canSeeBoard(b, user)) return;
    const tmp = a.tabOrder;
    a.tabOrder = b.tabOrder;
    b.tabOrder = tmp;
    persist();
    broadcastState();
  });

  // ---- groups ----
  socket.on("addGroup", ({ name, boardId, visibility }) => {
    if (!name || typeof name !== "string") return;
    const board = boardById(boardId);
    if (!board || !canSeeBoard(board, user)) return;
    const isPrivate = visibility === "private";
    const order = state.groups.filter((g) => g.boardId === boardId).length;
    const group = {
      id: uid("g"), boardId, name: autoCapitalize(name.trim().slice(0, 200)) || "Untitled",
      color: GROUP_COLORS[order % GROUP_COLORS.length], order,
      visibility: isPrivate ? "private" : "shared",
      ownerId: isPrivate ? user.id : undefined,
      createdAt: Date.now(), createdBy: actorName()
    };
    state.groups.push(group);
    if (!isPrivate) logActivity(`${actorName()} added the group "${group.name}"`);
    persist();
    broadcastState();
  });

  socket.on("updateGroup", ({ id, patch }) => {
    const g = groupById(id);
    if (!g || !patch || !canTouchGroup(g)) return;
    if (typeof patch.name === "string") {
      const oldName = g.name;
      g.name = autoCapitalize(patch.name.trim().slice(0, 200)) || "Untitled";
      g.updatedBy = actorName();
      g.updatedAt = nowIso();
      if (oldName !== g.name && g.visibility !== "private") logActivity(`${actorName()} renamed the group "${oldName}" to "${g.name}"`);
    }
    if (typeof patch.order === "number" && Number.isFinite(patch.order)) {
      g.order = patch.order;
    }
    persist();
    broadcastState();
  });

  // Swap the display order of two groups at once (used for the up/down
  // reorder controls, including when viewing "All boards" mixed together).
  socket.on("swapGroupOrder", ({ idA, idB }) => {
    const a = groupById(idA);
    const b = groupById(idB);
    if (!a || !b || !canTouchGroup(a) || !canTouchGroup(b)) return;
    const tmp = a.order;
    a.order = b.order;
    b.order = tmp;
    persist();
    broadcastState();
  });

  socket.on("deleteGroup", ({ id }) => {
    const g = groupById(id);
    if (!g || !canTouchGroup(g)) return;
    const hasItems = state.items.some((i) => i.groupId === id);
    if (hasItems) return; // only empty groups can be deleted
    state.groups = state.groups.filter((x) => x.id !== id);
    if (g.visibility !== "private") logActivity(`${actorName()} deleted the group "${g.name}"`);
    persist();
    broadcastState();
  });

  // ---- items ----
  socket.on("addItem", ({ groupId, title, order }) => {
    if (!groupId || !title || typeof title !== "string") return;
    const group = groupById(groupId);
    if (!group || !canTouchGroup(group)) return;
    const item = {
      id: uid("i"), groupId,
      title: autoCapitalize(title.trim().slice(0, 500) || "Untitled task"),
      notes: "", notesList: [], priority: "low",
      assigneeIds: [], steps: [], archived: false, completed: false, files: [],
      order: typeof order === "number" ? order : state.items.length,
      createdAt: Date.now(), createdBy: actorName(), createdById: user.id, updatedBy: actorName(), updatedAt: nowIso()
    };
    state.items.push(item);
    if (group.visibility !== "private") logActivity(`${actorName()} added "${item.title}" to ${group.name}`);
    persist();
    broadcastState();
  });

  socket.on("swapItemOrder", ({ idA, idB }) => {
    const a = state.items.find((x) => x.id === idA);
    const b = state.items.find((x) => x.id === idB);
    if (!a || !b) return;
    const groupA = groupById(a.groupId);
    const groupB = groupById(b.groupId);
    if (!canTouchGroup(groupA) || !canTouchGroup(groupB)) return;
    const tmp = a.order;
    a.order = b.order;
    b.order = tmp;
    persist();
    broadcastState();
  });

  socket.on("updateItem", ({ id, patch }) => {
    const item = state.items.find((x) => x.id === id);
    if (!item || !patch) return;
    const group = groupById(item.groupId);
    if (!canTouchGroup(group)) return;
    let changeDesc = null;

    if (typeof patch.title === "string") {
      const t = autoCapitalize(patch.title.trim().slice(0, 500) || "Untitled task");
      if (t !== item.title) { item.title = t; changeDesc = `renamed a task to "${item.title}"`; }
    }
    if (["low", "medium", "high"].includes(patch.priority) && patch.priority !== item.priority) {
      item.priority = patch.priority;
      changeDesc = `set "${item.title}" priority to ${patch.priority}`;
    }
    if (typeof patch.notes === "string" && patch.notes !== item.notes) {
      item.notes = patch.notes.slice(0, 4000);
      changeDesc = `updated the notes on "${item.title}"`;
    }
    if (Array.isArray(patch.assigneeIds)) {
      const validIds = new Set(users.map((u) => u.id));
      const next = [...new Set(patch.assigneeIds.filter((aid) => validIds.has(aid)))].slice(0, 20);
      const changed = next.length !== item.assigneeIds.length || next.some((x) => !item.assigneeIds.includes(x));
      if (changed) {
        item.assigneeIds = next;
        const names = next.map((aid) => { const u = findUserById(aid); return u ? (u.displayName || u.username) : null; }).filter(Boolean);
        changeDesc = names.length ? `assigned "${item.title}" to ${names.join(", ")}` : `unassigned "${item.title}"`;
      }
    }

    if (changeDesc) {
      item.updatedBy = actorName();
      item.updatedAt = nowIso();
      if (group.visibility !== "private") logActivity(`${actorName()} ${changeDesc}`);
    }
    persist();
    broadcastState();
  });

  // ---- multiple notes per task (each its own entry, collapsed until opened) ----
  socket.on("addNote", ({ itemId, text }) => {
    const item = state.items.find((x) => x.id === itemId);
    if (!item || typeof text !== "string" || !text.trim()) return;
    const group = groupById(item.groupId);
    if (!canTouchGroup(group)) return;
    if (!Array.isArray(item.notesList)) item.notesList = [];
    item.notesList.push({
      id: uid("n"), text: text.trim().slice(0, 4000),
      createdBy: actorName(), createdById: user.id, createdAt: nowIso(),
      updatedBy: actorName(), updatedById: user.id, updatedAt: nowIso()
    });
    item.updatedBy = actorName();
    item.updatedAt = nowIso();
    persist();
    broadcastState();
  });

  socket.on("updateNote", ({ itemId, noteId, text }) => {
    const item = state.items.find((x) => x.id === itemId);
    if (!item || !Array.isArray(item.notesList) || typeof text !== "string") return;
    const group = groupById(item.groupId);
    if (!canTouchGroup(group)) return;
    const note = item.notesList.find((n) => n.id === noteId);
    if (!note) return;
    const t = text.trim().slice(0, 4000);
    if (!t || t === note.text) return;
    note.text = t;
    note.updatedBy = actorName();
    note.updatedById = user.id;
    note.updatedAt = nowIso();
    item.updatedBy = actorName();
    item.updatedAt = nowIso();
    persist();
    broadcastState();
  });

  socket.on("deleteNote", ({ itemId, noteId }) => {
    const item = state.items.find((x) => x.id === itemId);
    if (!item || !Array.isArray(item.notesList)) return;
    const group = groupById(item.groupId);
    if (!canTouchGroup(group)) return;
    item.notesList = item.notesList.filter((n) => n.id !== noteId);
    item.updatedBy = actorName();
    item.updatedAt = nowIso();
    persist();
    broadcastState();
  });

  socket.on("deleteItem", ({ id }) => {
    const item = state.items.find((x) => x.id === id);
    if (!item) return;
    const group = groupById(item.groupId);
    if (!canTouchGroup(group)) return;
    // Only an admin or whoever created the task can delete it. Tasks created
    // before this restriction existed (no createdById on record) can still be
    // deleted by anyone with access, so nothing old gets permanently stuck.
    if (item.createdById && item.createdById !== user.id && user.role !== "admin") return;
    state.items = state.items.filter((x) => x.id !== id);
    state.messages = state.messages.filter((m) => !(m.scope === "item" && m.scopeId === id));
    if (group.visibility !== "private") logActivity(`${actorName()} deleted "${item.title}"`);
    persist();
    broadcastState();
    removeItemUploads(id);
  });

  // ---- steps: a persistent checklist per task. Any number of steps can be
  // open at once; each has its own done/undone toggle. Completing the whole
  // task (archiving it) is a separate action from finishing individual steps.
  socket.on("addTaskStep", async ({ itemId, text }) => {
    const item = state.items.find((x) => x.id === itemId);
    if (!item) return;
    const group = groupById(item.groupId);
    if (!canTouchGroup(group)) return;
    if (!text || !String(text).trim()) return;

    const step = {
      id: uid("s"), text: autoCapitalize(String(text).trim().slice(0, 1000)), done: false,
      byId: user.id, byName: actorName(), createdAt: nowIso()
    };
    item.steps.push(step);
    item.updatedBy = actorName();
    item.updatedAt = nowIso();
    if (group.visibility !== "private") logActivity(`${actorName()} added a step to "${item.title}"`);
    persist();
    broadcastState();

    if (item.assigneeIds.length) {
      const link = itemLink(item);
      for (const aid of item.assigneeIds) {
        if (aid === user.id) continue;
        const u = findUserById(aid);
        if (u && u.email) {
          await sendMail(u.email, `New step on: ${item.title}`, `${actorName()} added a step on "${item.title}":\n\n${step.text}${link ? "\n\nOpen this task: " + link : ""}`);
        }
      }
    }
  });

  socket.on("toggleTaskStep", ({ itemId, stepId, done }) => {
    const item = state.items.find((x) => x.id === itemId);
    if (!item) return;
    const group = groupById(item.groupId);
    if (!canTouchGroup(group)) return;
    const step = item.steps.find((s) => s.id === stepId);
    if (!step) return;
    step.done = !!done;
    step.doneById = step.done ? user.id : undefined;
    step.doneByName = step.done ? actorName() : undefined;
    step.doneAt = step.done ? nowIso() : undefined;
    item.updatedBy = actorName();
    item.updatedAt = nowIso();
    if (group.visibility !== "private") logActivity(`${actorName()} marked a step ${step.done ? "done" : "not done"} on "${item.title}"`);
    persist();
    broadcastState();
  });

  socket.on("updateTaskStep", ({ itemId, stepId, text }) => {
    const item = state.items.find((x) => x.id === itemId);
    if (!item) return;
    const group = groupById(item.groupId);
    if (!canTouchGroup(group)) return;
    const step = item.steps.find((s) => s.id === stepId);
    if (!step || typeof text !== "string" || !text.trim()) return;
    step.text = autoCapitalize(text.trim().slice(0, 1000));
    item.updatedBy = actorName();
    item.updatedAt = nowIso();
    persist();
    broadcastState();
  });

  socket.on("deleteTaskStep", ({ itemId, stepId }) => {
    const item = state.items.find((x) => x.id === itemId);
    if (!item) return;
    const group = groupById(item.groupId);
    if (!canTouchGroup(group)) return;
    item.steps = item.steps.filter((s) => s.id !== stepId);
    item.updatedBy = actorName();
    item.updatedAt = nowIso();
    persist();
    broadcastState();
  });

  // "Complete" and "Archive" are two separate steps now, not one: completing a
  // task just marks it done in place (still visible, still in its group, still
  // reorderable) — it does NOT move anywhere. Archiving is a distinct, explicit
  // action that only makes sense (and is only offered client-side) once a task
  // is already complete, and moving it to Archived is what actually hides it
  // from the normal view behind "Show archived".
  socket.on("completeTask", ({ itemId }) => {
    const item = state.items.find((x) => x.id === itemId);
    if (!item) return;
    const group = groupById(item.groupId);
    if (!canTouchGroup(group)) return;
    item.completed = true;
    item.updatedBy = actorName();
    item.updatedAt = nowIso();
    if (group.visibility !== "private") logActivity(`${actorName()} completed "${item.title}"`);
    persist();
    broadcastState();
  });

  socket.on("uncompleteTask", ({ itemId }) => {
    const item = state.items.find((x) => x.id === itemId);
    if (!item) return;
    const group = groupById(item.groupId);
    if (!canTouchGroup(group)) return;
    item.completed = false;
    item.updatedBy = actorName();
    item.updatedAt = nowIso();
    if (group.visibility !== "private") logActivity(`${actorName()} marked "${item.title}" not complete`);
    persist();
    broadcastState();
  });

  socket.on("archiveTask", ({ itemId }) => {
    const item = state.items.find((x) => x.id === itemId);
    if (!item) return;
    const group = groupById(item.groupId);
    if (!canTouchGroup(group)) return;
    if (!item.completed) return; // archiving only makes sense once a task is complete
    item.archived = true;
    item.updatedBy = actorName();
    item.updatedAt = nowIso();
    if (group.visibility !== "private") logActivity(`${actorName()} archived "${item.title}"`);
    persist();
    broadcastState();
  });

  socket.on("unarchiveTask", ({ itemId }) => {
    const item = state.items.find((x) => x.id === itemId);
    if (!item) return;
    const group = groupById(item.groupId);
    if (!canTouchGroup(group)) return;
    item.archived = false;
    item.updatedBy = actorName();
    item.updatedAt = nowIso();
    if (group.visibility !== "private") logActivity(`${actorName()} unarchived "${item.title}"`);
    persist();
    broadcastState();
  });

  // ---- personal/shared to-do list ----
  // Separate from boards/tasks entirely — not tied to any board, group, or task.
  // Private to its creator unless sharedWith names other people, in which case it
  // also shows up on their list. Anyone it's shared with can check it off too
  // (that's the point — coordinating), but only the creator can edit who it's
  // shared with or delete it outright.
  socket.on("addTodo", ({ text, sharedWith }) => {
    if (typeof text !== "string" || !text.trim()) return;
    const validIds = new Set(users.map((u) => u.id));
    const shared = Array.isArray(sharedWith)
      ? [...new Set(sharedWith.filter((sid) => validIds.has(sid) && sid !== user.id))].slice(0, 50)
      : [];
    const todo = {
      id: uid("t"), text: text.trim().slice(0, 500), done: false,
      createdBy: actorName(), createdById: user.id, createdAt: nowIso(), updatedAt: nowIso(),
      sharedWith: shared
    };
    state.todos.push(todo);
    persist();
    broadcastState();
  });

  socket.on("toggleTodo", ({ id, done }) => {
    const todo = state.todos.find((t) => t.id === id);
    if (!todo) return;
    if (todo.createdById !== user.id && !(todo.sharedWith || []).includes(user.id)) return; // must be able to see it to check it off
    todo.done = !!done;
    todo.updatedAt = nowIso();
    persist();
    broadcastState();
  });

  socket.on("updateTodoText", ({ id, text }) => {
    const todo = state.todos.find((t) => t.id === id);
    if (!todo || todo.createdById !== user.id) return; // owner only
    if (typeof text !== "string" || !text.trim()) return;
    todo.text = text.trim().slice(0, 500);
    todo.updatedAt = nowIso();
    persist();
    broadcastState();
  });

  socket.on("shareTodo", ({ id, sharedWith }) => {
    const todo = state.todos.find((t) => t.id === id);
    if (!todo || todo.createdById !== user.id) return; // owner only — only the creator decides who else sees it
    const validIds = new Set(users.map((u) => u.id));
    todo.sharedWith = Array.isArray(sharedWith)
      ? [...new Set(sharedWith.filter((sid) => validIds.has(sid) && sid !== user.id))].slice(0, 50)
      : [];
    // Re-sharing restores visibility for anyone who "removed for me"
    if (todo.removedBy) {
      todo.removedBy = todo.removedBy.filter((uid) => !todo.sharedWith.includes(uid));
      if (!todo.removedBy.length) delete todo.removedBy;
    }
    todo.updatedAt = nowIso();
    persist();
    broadcastState();
  });

  socket.on("deleteTodo", ({ id, forEveryone }) => {
    const todo = state.todos.find((t) => t.id === id);
    if (!todo) return;
    // Must be able to see it to delete it
    const canSee = todo.createdById === user.id || (todo.sharedWith || []).includes(user.id);
    if (!canSee) return;
    if (forEveryone) {
      state.todos = state.todos.filter((t) => t.id !== id);
    } else {
      // "Delete for me" — hide it from this user only via removedBy
      if (!todo.removedBy) todo.removedBy = [];
      if (!todo.removedBy.includes(user.id)) todo.removedBy.push(user.id);
    }
    todo.updatedAt = nowIso();
    persist();
    broadcastState();
  });

  // ---- messages: per-board chat and per-task chat, with @mention notifications ----
  socket.on("addMessage", async ({ scope, scopeId, text, mentionIds }) => {
    if (scope !== "board" && scope !== "item") return;
    if (!text || !String(text).trim()) return;
    let label = null;
    let linkUrl = "";
    if (scope === "board") {
      const board = boardById(scopeId);
      if (!board || !canSeeBoard(board, user)) return;
      if (board.private) return; // private boards have no chat at all
      label = board.name;
      linkUrl = boardLink(board.id);
    } else {
      const item = state.items.find((x) => x.id === scopeId);
      if (!item) return;
      const group = groupById(item.groupId);
      if (!canTouchGroup(group)) return;
      label = item.title;
      linkUrl = itemLink(item);
    }

    const trimmed = String(text).trim().slice(0, 2000);
    let mentionedIds;
    if (Array.isArray(mentionIds)) {
      // Explicit recipient selection from the client's checkbox list — the
      // authoritative source now, no more parsing "@name" out of the text.
      const validIds = new Set(users.map((u) => u.id));
      mentionedIds = [...new Set(mentionIds.filter((mid) => validIds.has(mid)))];
    } else {
      mentionedIds = [];
      for (const u of activeUsers()) {
        const handles = [u.username, u.displayName].filter(Boolean);
        for (const h of handles) {
          const re = new RegExp("@" + h.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\b", "i");
          if (re.test(trimmed) && !mentionedIds.includes(u.id)) { mentionedIds.push(u.id); break; }
        }
      }
    }

    const message = {
      id: uid("m"), scope, scopeId, text: trimmed,
      byId: user.id, byName: actorName(), at: nowIso(), mentions: mentionedIds,
      readBy: [{ userId: user.id, userName: actorName(), at: nowIso() }] // the author has implicitly "read" their own message
    };
    state.messages.push(message);
    if (state.messages.length > 2000) state.messages = state.messages.slice(-2000);
    persist();
    broadcastState();

    for (const mid of mentionedIds) {
      if (mid === user.id) continue;
      const mentioned = findUserById(mid);
      if (mentioned && mentioned.email) {
        // Append the specific message's own id so the link lands right on the
        // message that triggered the notification instead of just the chat it
        // came from — the client scrolls to and highlights it on load.
        const msgLink = linkUrl ? linkUrl + "&message=" + encodeURIComponent(message.id) : "";
        await sendMail(mentioned.email, `You were mentioned in ${label}`, `${actorName()} mentioned you:\n\n${trimmed}${msgLink ? "\n\nOpen this message: " + msgLink : ""}`);
      }
    }
  });

  socket.on("updateMessage", ({ id, text }) => {
    const m = state.messages.find((x) => x.id === id);
    if (!m || !text || !String(text).trim()) return;
    if (m.byId !== user.id) return; // strictly own messages only — no admin override
    m.text = String(text).trim().slice(0, 2000);
    m.editedAt = nowIso();
    persist();
    broadcastState();
  });

  socket.on("deleteMessage", ({ id }) => {
    const m = state.messages.find((x) => x.id === id);
    if (!m) return;
    if (m.byId !== user.id) return; // strictly own messages only — no admin override
    state.messages = state.messages.filter((x) => x.id !== id);
    persist();
    broadcastState();
  });

  // Mark every message currently visible in a board/task chat as read by this
  // user, so others can see who has (and hasn't) seen a given message.
  socket.on("markMessagesRead", ({ scope, scopeId }) => {
    if (scope !== "board" && scope !== "item") return;
    if (scope === "board") {
      const board = boardById(scopeId);
      if (!board || !canSeeBoard(board, user)) return;
    } else {
      const item = state.items.find((x) => x.id === scopeId);
      if (!item) return;
      const group = groupById(item.groupId);
      if (!canTouchGroup(group)) return;
    }
    let changed = false;
    for (const m of state.messages) {
      if (m.scope !== scope || m.scopeId !== scopeId) continue;
      if (!m.readBy) m.readBy = [];
      if (!m.readBy.some((r) => r.userId === user.id)) {
        m.readBy.push({ userId: user.id, userName: actorName(), at: nowIso() });
        changed = true;
      }
    }
    if (changed) { persist(); broadcastState(); }
  });

  // ---- notify assignees it's their turn ----
  socket.on("notifyTurn", async ({ itemId }) => {
    const item = state.items.find((x) => x.id === itemId);
    if (!item || !item.assigneeIds || !item.assigneeIds.length) return;
    const group = groupById(item.groupId);
    if (!canTouchGroup(group)) return;
    const assignees = item.assigneeIds.map((aid) => findUserById(aid)).filter(Boolean);
    if (!assignees.length) return;
    if (group.visibility !== "private") logActivity(`${actorName()} notified ${assignees.map((a) => a.displayName).join(", ")} that it's their turn on "${item.title}"`);
    persist();
    broadcastState();
    const link = itemLink(item);
    for (const assignee of assignees) {
      if (assignee.email) await sendMail(assignee.email, `It's your turn: ${item.title}`, `${actorName()} says it's your turn on "${item.title}".${link ? "\n\nOpen this task: " + link : ""}`);
    }
  });
});

// ---- Google & Microsoft OAuth routes ----
// prompt=select_account makes the provider ask WHICH account to connect every
// time, so the same person can add a second Google or Microsoft account
// instead of silently reconnecting whichever one the browser is signed into.
app.get("/auth/google", requireAuth, (req, res) => {
  if (!GOOGLE_CLIENT_ID) return res.status(503).send("Google Calendar not configured");
  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: GOOGLE_REDIRECT,
    response_type: "code",
    scope: "https://www.googleapis.com/auth/calendar",
    access_type: "offline",
    prompt: "consent select_account"
  });
  res.redirect("https://accounts.google.com/o/oauth2/v2/auth?" + params);
});

app.get("/auth/google/callback", requireAuth, async (req, res) => {
  const { code, error } = req.query;
  if (error || !code) return res.redirect("/#admin?cal=error");
  const params = new URLSearchParams({
    code, client_id: GOOGLE_CLIENT_ID, client_secret: GOOGLE_CLIENT_SECRET,
    redirect_uri: GOOGLE_REDIRECT, grant_type: "authorization_code"
  }).toString();
  try {
    const r = await httpsRequest({
      hostname: "oauth2.googleapis.com", path: "/token", method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "Content-Length": Buffer.byteLength(params) }
    }, params);
    if (!r.body.access_token) return res.redirect("/#admin?cal=error");
    // A Google account's primary calendar id IS its email address — reuse it
    // as the account label, so no extra profile/email permission is needed.
    let email = "";
    try {
      const list = await googleApiRequest(r.body.access_token, "GET", "/calendar/v3/users/me/calendarList");
      const primary = list.body && list.body.items && list.body.items.find((c) => c.primary);
      email = primary ? primary.id : "";
    } catch (e) {}
    saveAccount(req.session.userId, "google", {
      email,
      accessToken: r.body.access_token,
      refreshToken: r.body.refresh_token,
      expiresAt: new Date(Date.now() + (r.body.expires_in || 3600) * 1000).toISOString()
    });
    res.redirect("/#admin?cal=connected");
  } catch (e) { res.redirect("/#admin?cal=error"); }
});

app.get("/auth/microsoft", requireAuth, (req, res) => {
  if (!MICROSOFT_CLIENT_ID) return res.status(503).send("Microsoft Calendar not configured");
  const params = new URLSearchParams({
    client_id: MICROSOFT_CLIENT_ID,
    redirect_uri: MICROSOFT_REDIRECT,
    response_type: "code",
    scope: "Calendars.ReadWrite offline_access User.Read",
    response_mode: "query",
    prompt: "select_account"
  });
  res.redirect(`https://login.microsoftonline.com/${MICROSOFT_TENANT_ID}/oauth2/v2.0/authorize?` + params);
});

app.get("/auth/microsoft/callback", requireAuth, async (req, res) => {
  const { code, error } = req.query;
  if (error || !code) return res.redirect("/#admin?cal=error");
  const params = new URLSearchParams({
    client_id: MICROSOFT_CLIENT_ID, client_secret: MICROSOFT_CLIENT_SECRET,
    code, redirect_uri: MICROSOFT_REDIRECT, grant_type: "authorization_code",
    scope: "Calendars.ReadWrite offline_access User.Read"
  }).toString();
  try {
    const r = await httpsRequest({
      hostname: "login.microsoftonline.com",
      path: `/${MICROSOFT_TENANT_ID}/oauth2/v2.0/token`,
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "Content-Length": Buffer.byteLength(params) }
    }, params);
    if (!r.body.access_token) return res.redirect("/#admin?cal=error");
    const meR = await graphRequest(r.body.access_token, "GET", "/me");
    saveAccount(req.session.userId, "microsoft", {
      email: (meR.body && (meR.body.mail || meR.body.userPrincipalName)) || "",
      accessToken: r.body.access_token,
      refreshToken: r.body.refresh_token,
      expiresAt: new Date(Date.now() + (r.body.expires_in || 3600) * 1000).toISOString()
    });
    res.redirect("/#admin?cal=connected");
  } catch (e) { res.redirect("/#admin?cal=error"); }
});

// Disconnect ONE specific connected account (only if it belongs to you)
app.delete("/api/calendar/accounts/:id", requireAuth, (req, res) => {
  if (!getAccount(req.session.userId, req.params.id)) return res.status(404).json({ error: "not_found" });
  removeAccount(req.session.userId, req.params.id);
  invalidateCalendarCache(`ev:${req.params.id}:`);
  invalidateCalendarCache(`cals:${req.params.id}`);
  res.json({ ok: true });
});

// ---- Calendar API endpoints (all scoped to the logged-in user's own connections) ----

// Every connected account, with the calendars inside each one
app.get("/api/calendar/accounts", requireAuth, async (req, res) => {
  const hidden = hiddenSet(req.session.userId);
  const accounts = listAccounts(req.session.userId);
  const out = await Promise.all(accounts.map(async (acct) => {
    try {
      const a = await freshToken(acct);
      const calendars = (await listCalendarsFor(a)).map((c) => ({ ...c, key: acct.id + "|" + c.id, visible: !hidden.has(acct.id + "|" + c.id) }));
      return { id: acct.id, provider: acct.provider, email: acct.email, calendars };
    } catch (e) {
      // e.g. access was revoked on Google/Microsoft's side — show it so it can be reconnected
      return { id: acct.id, provider: acct.provider, email: acct.email, calendars: [], error: true };
    }
  }));
  const builtin = BUILTIN_CALENDARS.map((c) => ({ ...c, key: "builtin|" + c.id, visible: !hidden.has("builtin|" + c.id) }));
  const localCal = { id: "local", provider: "local", email: "", calendars: [
    { id: "avenium", key: "local|avenium", name: "Avenium", canEdit: true, primary: true, visible: !hidden.has("local|avenium") }
  ] };
  res.json({ accounts: [localCal, ...out], builtin, googleConfigured: !!GOOGLE_CLIENT_ID, microsoftConfigured: !!MICROSOFT_CLIENT_ID, showHebrew: getShowHebrew(req.session.userId) });
});

// Show / hide one calendar on this user's own view
app.post("/api/calendar/visibility", requireAuth, (req, res) => {
  const { key, visible } = req.body || {};
  if (typeof key !== "string" || !key) return res.status(400).json({ error: "invalid_request" });
  const accountId = key.split("|")[0];
  if (accountId !== "builtin" && accountId !== "local" && !getAccount(req.session.userId, accountId)) return res.status(404).json({ error: "not_found" });
  setCalendarVisible(req.session.userId, key, !!visible);
  res.json({ ok: true });
});

app.post("/api/calendar/show-hebrew", requireAuth, (req, res) => {
  const { show } = req.body || {};
  setShowHebrew(req.session.userId, !!show);
  res.json({ ok: true });
});

// Events from every calendar in every connected account, for a date range
app.get("/api/calendar/events", requireAuth, async (req, res) => {
  const timeMin = req.query.start ? new Date(req.query.start).toISOString() : new Date(Date.now() - 31 * 86400000).toISOString();
  const timeMax = req.query.end ? new Date(req.query.end).toISOString() : new Date(Date.now() + 62 * 86400000).toISOString();
  const hidden = hiddenSet(req.session.userId);
  const accounts = listAccounts(req.session.userId);
  const all = [];
  const rangeKey = timeMin.slice(0, 10) + ".." + timeMax.slice(0, 10);
  await Promise.all(BUILTIN_CALENDARS.filter((c) => !hidden.has("builtin|" + c.id)).map(async (def) => {
    try {
      // holidays for a given range never change — hold them for 12 hours
      const events = await cachedFetch(`builtin:${def.id}:${rangeKey}`, 12 * 60 * 60 * 1000,
        () => fetchBuiltinEvents(def.id, timeMin, timeMax));
      events.forEach((ev) => all.push({
        ...ev, provider: "builtin", accountId: "builtin", accountEmail: "",
        calendarId: def.id, calendarName: def.name, color: def.color, canEdit: false
      }));
    } catch (e) {}
  }));
  await Promise.all(accounts.map(async (acct) => {
    try {
      const a = await freshToken(acct);
      const calendars = (await listCalendarsFor(a)).filter((c) => !hidden.has(acct.id + "|" + c.id));
      await Promise.all(calendars.map(async (cal) => {
        try {
          // 60 seconds: month navigation and revisits are instant, while a
          // change made elsewhere still appears within the minute. Creating or
          // editing here clears this immediately (see below), so your own
          // changes always show at once.
          const events = await cachedFetch(`ev:${a.id}:${cal.id}:${rangeKey}`, 60 * 1000, () =>
            a.provider === "google"
              ? fetchGoogleCalendarEvents(a, cal, timeMin, timeMax)
              : fetchMicrosoftCalendarEvents(a, cal, timeMin, timeMax));
          events.forEach((ev) => all.push({
            ...ev, provider: a.provider, accountId: a.id, accountEmail: a.email,
            calendarId: cal.id, calendarName: cal.name, color: cal.color, canEdit: cal.canEdit
          }));
        } catch (e) {}
      }));
    } catch (e) {}
  }));
  // ---- Local (app-native) events ----
  if (!hidden.has("local|avenium")) {
    const startDate = timeMin.slice(0, 10);
    const endDate = timeMax.slice(0, 10);
    const userLocal = localEvents.filter((e) => e.userId === req.session.userId);
    userLocal.forEach((ev) => {
      const instances = expandLocalEvent(ev, startDate, endDate);
      instances.forEach((inst) => all.push({
        ...inst, provider: "local", accountId: "local", accountEmail: "",
        calendarId: "avenium", calendarName: "Avenium", color: "#3C5A46", canEdit: true,
        externalId: ev.id
      }));
    });
  }
  res.json({ events: all });
});

// Search every visible calendar the user has (Avenium, Google, Outlook) for
// events whose title, description or location contain every word typed.
// Independent of whatever month the grid is showing. No result cap.
// Built-in holiday/parsha feeds are excluded, same as the agenda.
app.get("/api/calendar/search", requireAuth, async (req, res) => {
  const q = String(req.query.q || "").trim().toLowerCase();
  if (!q) return res.json({ events: [], total: 0, errors: [] });
  const words = q.split(/\s+/).filter(Boolean);
  const thisYear = new Date().getUTCFullYear();
  const timeMin = req.query.start ? new Date(req.query.start + "T00:00:00Z").toISOString() : "1900-01-01T00:00:00.000Z";
  const timeMax = req.query.end ? new Date(new Date(req.query.end + "T00:00:00Z").getTime() + 86400000).toISOString() : (thisYear + 11) + "-01-01T00:00:00.000Z";
  if (isNaN(new Date(timeMin)) || isNaN(new Date(timeMax))) return res.status(400).json({ error: "invalid_range" });
  const rangeKey = timeMin.slice(0, 10) + ".." + timeMax.slice(0, 10);
  const hidden = hiddenSet(req.session.userId);
  const rangeStartDay = timeMin.slice(0, 10);
  const rangeEndDay = new Date(new Date(timeMax).getTime() - 1).toISOString().slice(0, 10); // timeMax is exclusive
  const inRange = (ev) => { const d = String(ev.start || "").slice(0, 10); return d >= rangeStartDay && d <= rangeEndDay; };
  const matches = (ev) => {
    if (!inRange(ev)) return false;
    const hay = ((ev.title || "") + " " + (ev.description || "") + " " + (ev.location || "")).toLowerCase();
    return words.every((w) => hay.indexOf(w) !== -1);
  };
  const found = [];
  const errors = [];
  const searched = [];
  if (!hidden.has("local|avenium")) searched.push({ label: "Avenium", calendars: 1 });
  await Promise.all(listAccounts(req.session.userId).map(async (acct) => {
    try {
      const a = await freshToken(acct);
      if (!a || !a.accessToken) throw new Error("sign-in expired — reconnect on the Admin page");
      const calendars = (await listCalendarsFor(a)).filter((c) => !hidden.has(acct.id + "|" + c.id));
      searched.push({ label: acct.email || acct.provider, provider: acct.provider, calendars: calendars.length });
      await Promise.all(calendars.map(async (cal) => {
        try {
          // Same "ev:<account>:" prefix as the grid cache, so creating/editing
          // an event here clears this too. 5 minutes so typing is instant.
          const events = await cachedFetch(`ev:${a.id}:${cal.id}:${rangeKey}`, 5 * 60 * 1000, () =>
            a.provider === "google"
              ? fetchGoogleCalendarEvents(a, cal, timeMin, timeMax)
              : fetchMicrosoftCalendarEvents(a, cal, timeMin, timeMax));
          events.filter(matches).forEach((ev) => found.push({
            ...ev, provider: a.provider, accountId: a.id, accountEmail: a.email,
            calendarId: cal.id, calendarName: cal.name, color: cal.color, canEdit: cal.canEdit
          }));
        } catch (e) { errors.push(acct.email + " / " + cal.name + " (" + e.message + ")"); }
      }));
    } catch (e) { errors.push(acct.email + " (" + e.message + ")"); }
  }));
  if (!hidden.has("local|avenium")) {
    const startDate = timeMin.slice(0, 10), endDate = timeMax.slice(0, 10);
    localEvents.filter((e) => e.userId === req.session.userId).forEach((ev) => {
      const hay = ((ev.title || "") + " " + (ev.description || "") + " " + (ev.location || "")).toLowerCase();
      if (!words.every((w) => hay.indexOf(w) !== -1)) return;
      expandLocalEvent(ev, startDate, endDate).filter(inRange).forEach((inst) => found.push({
        ...inst, provider: "local", accountId: "local", accountEmail: "",
        calendarId: "avenium", calendarName: "Avenium", color: "#3C5A46", canEdit: true,
        externalId: ev.id
      }));
    });
  }
  found.sort((x, y) => new Date(x.start) - new Date(y.start));
  searched.sort((x, y) => (x.label === "Avenium" ? -1 : y.label === "Avenium" ? 1 : x.label.localeCompare(y.label)));
  res.json({ events: found, total: found.length, errors, searched });
});

app.post("/api/calendar/events", requireAuth, async (req, res) => {
  const { accountId, calendarId, title, start, end, description, location, attendees, allDay, reminderMinutes, repeat, repeatUntil, hebrewDay, hebrewMonth, hebrewYear } = req.body || {};
  if (!title || !start) return res.status(400).json({ error: "invalid_request" });
  const isJewishRepeat = repeat === "jewish-monthly" || repeat === "jewish-yearly";
  if (isJewishRepeat && hebrewYear && !hebrewToGregorianFlex(Number(hebrewYear), hebrewMonth || "Tishri", Number(hebrewDay))) {
    return res.status(400).json({ error: "invalid_hebrew_date" });
  }

  // Local (app-native) event — no provider call needed
  if (accountId === "local") {
    const id = "lev_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    const ev = {
      id, userId: req.session.userId, title, start, end: end || start, allDay: !!allDay,
      description: description || "", location: location || "",
      attendees: attendees || [], repeat: repeat || "none",
      repeatUntil: repeatUntil || "", createdAt: new Date().toISOString()
    };
    if (hebrewDay) ev.hebrewDay = hebrewDay;
    if (hebrewMonth) ev.hebrewMonth = hebrewMonth;
    if (isJewishRepeat && hebrewYear) ev.hebrewYear = Number(hebrewYear);
    localEvents.push(ev);
    persistLocalEvents();
    return res.json({ ok: true });
  }

  const acct = getAccount(req.session.userId, accountId);
  if (!acct || !calendarId) return res.status(400).json({ error: "invalid_request" });
  try {
    const a = await freshToken(acct);
    const ev = { title, start, end, description, location, attendees, allDay, reminderMinutes, repeat, repeatUntil };
    const r = a.provider === "google"
      ? await googleApiRequest(a.accessToken, "POST", `/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`, googleEventBody(ev))
      : await graphRequest(a.accessToken, "POST", `/me/calendars/${encodeURIComponent(calendarId)}/events`, microsoftEventBody(ev));
    if (r.status >= 300) return res.status(502).json({ error: "provider_rejected" });
    invalidateCalendarCache(`ev:${a.id}:`); // own change must show immediately
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put("/api/calendar/events", requireAuth, async (req, res) => {
  const { accountId, calendarId, eventId, title, start, end, description, location, attendees, allDay, reminderMinutes, repeat, repeatUntil, hebrewDay, hebrewMonth, hebrewYear, newAccountId, newCalendarId } = req.body || {};
  if ((repeat === "jewish-monthly" || repeat === "jewish-yearly") && hebrewYear && !hebrewToGregorianFlex(Number(hebrewYear), hebrewMonth || "Tishri", Number(hebrewDay))) {
    return res.status(400).json({ error: "invalid_hebrew_date" });
  }

  // Moving to a different calendar?
  var moveTarget = (newAccountId && newCalendarId && (newAccountId !== accountId || newCalendarId !== calendarId))
    ? { accountId: newAccountId, calendarId: newCalendarId } : null;

  // Local event edit
  if (accountId === "local") {
    const ev = localEvents.find((e) => e.id === eventId && e.userId === req.session.userId);
    if (!ev) return res.status(404).json({ error: "not_found" });
    if (title) ev.title = title;
    if (start) ev.start = start;
    if (end) ev.end = end;
    ev.allDay = !!allDay;
    if (description != null) ev.description = description;
    if (location != null) ev.location = location;
    if (attendees) ev.attendees = attendees;
    if (repeat !== undefined) ev.repeat = repeat || "none";
    if (repeatUntil !== undefined) ev.repeatUntil = repeatUntil || "";
    if (hebrewDay !== undefined) ev.hebrewDay = hebrewDay || null;
    if (hebrewMonth !== undefined) ev.hebrewMonth = hebrewMonth || null;
    if (hebrewYear !== undefined) ev.hebrewYear = hebrewYear ? Number(hebrewYear) : null;

    if (moveTarget && moveTarget.accountId !== "local") {
      // Moving from local to Google/Outlook — create there and delete local
      const acct2 = getAccount(req.session.userId, moveTarget.accountId);
      if (!acct2) return res.status(400).json({ error: "invalid_target" });
      try {
        const a2 = await freshToken(acct2);
        const evBody = { title: ev.title, start: ev.start, end: ev.end, description: ev.description, location: ev.location, attendees: ev.attendees, allDay: ev.allDay };
        const r2 = a2.provider === "google"
          ? await googleApiRequest(a2.accessToken, "POST", `/calendar/v3/calendars/${encodeURIComponent(moveTarget.calendarId)}/events`, googleEventBody(evBody))
          : await graphRequest(a2.accessToken, "POST", `/me/calendars/${encodeURIComponent(moveTarget.calendarId)}/events`, microsoftEventBody(evBody));
        if (r2.status >= 300) return res.status(502).json({ error: "provider_rejected" });
        localEvents = localEvents.filter((e) => e.id !== eventId);
        persistLocalEvents();
        invalidateCalendarCache(`ev:${a2.id}:`);
        return res.json({ ok: true });
      } catch (e) { return res.status(500).json({ error: e.message }); }
    }
    persistLocalEvents();
    return res.json({ ok: true });
  }

  const acct = getAccount(req.session.userId, accountId);
  if (!acct || !eventId) return res.status(400).json({ error: "invalid_request" });
  try {
    const a = await freshToken(acct);

    // Moving to local calendar?
    if (moveTarget && moveTarget.accountId === "local") {
      // Delete from provider, create local
      if (a.provider === "google") await googleApiRequest(a.accessToken, "DELETE", `/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`);
      else await graphRequest(a.accessToken, "DELETE", `/me/events/${encodeURIComponent(eventId)}`);
      const id = "lev_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
      localEvents.push({
        id, userId: req.session.userId, title: title || "", start: start || "", end: end || start || "", allDay: !!allDay,
        description: description || "", location: location || "", attendees: attendees || [],
        repeat: repeat || "none", repeatUntil: repeatUntil || "", createdAt: new Date().toISOString()
      });
      persistLocalEvents();
      invalidateCalendarCache(`ev:${a.id}:`);
      return res.json({ ok: true });
    }

    const ev = { title, start, end, description, location, attendees, allDay, reminderMinutes };
    const r = a.provider === "google"
      ? await googleApiRequest(a.accessToken, "PATCH", `/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`, googleEventBody(ev))
      : await graphRequest(a.accessToken, "PATCH", `/me/events/${encodeURIComponent(eventId)}`, microsoftEventBody(ev));
    if (r.status >= 300) return res.status(502).json({ error: "provider_rejected" });
    invalidateCalendarCache(`ev:${a.id}:`);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete("/api/calendar/events", requireAuth, async (req, res) => {
  const { accountId, calendarId, eventId } = req.query;

  // Local event delete
  if (accountId === "local") {
    const idx = localEvents.findIndex((e) => e.id === eventId && e.userId === req.session.userId);
    if (idx === -1) return res.status(404).json({ error: "not_found" });
    localEvents.splice(idx, 1);
    persistLocalEvents();
    return res.json({ ok: true });
  }

  const acct = getAccount(req.session.userId, accountId);
  if (!acct || !eventId) return res.status(400).json({ error: "invalid_request" });
  try {
    const a = await freshToken(acct);
    if (a.provider === "google") await googleApiRequest(a.accessToken, "DELETE", `/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`);
    else await graphRequest(a.accessToken, "DELETE", `/me/events/${encodeURIComponent(eventId)}`);
    invalidateCalendarCache(`ev:${a.id}:`);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Hebrew dates for a range of Gregorian dates — used by the frontend to show
// Hebrew dates on the calendar grid without an external API call
// Hebrew date -> Gregorian, for the event form's "Starts ..." line
app.get("/api/calendar/hebrew-to-gregorian", requireAuth, (req, res) => {
  const y = parseInt(req.query.year, 10), d = parseInt(req.query.day, 10), m = String(req.query.month || "");
  if (!(y >= 3761 && y <= 7000) || !(d >= 1 && d <= 30) || !m) return res.status(400).json({ error: "invalid_request" });
  const g = hebrewToGregorianFlex(y, m, d);
  if (!g) return res.json({ date: null });
  res.json({ date: gregKey(g), monthUsed: g.monthUsed });
});

app.get("/api/calendar/hebrew-dates", requireAuth, (req, res) => {
  const start = req.query.start; // "2026-09-01"
  const end = req.query.end;     // "2026-10-12"
  if (!start || !end) return res.status(400).json({ error: "invalid_request" });
  const results = {};
  var cur = new Date(start + "T12:00:00");
  var stop = new Date(end + "T12:00:00");
  var safety = 60; // max ~42 days per grid + buffer
  while (cur <= stop && safety-- > 0) {
    var key = cur.getFullYear() + "-" + String(cur.getMonth() + 1).padStart(2, "0") + "-" + String(cur.getDate()).padStart(2, "0");
    var heb = gregorianToHebrew(cur.getFullYear(), cur.getMonth() + 1, cur.getDate());
    results[key] = { day: heb.day, month: heb.monthName, year: heb.year };
    cur.setDate(cur.getDate() + 1);
  }
  res.json({ dates: results });
});

// ---- Claude assistant ----
// The key lives on the server only, never in the browser. Each request is
// answered with just THIS user's own boards, tasks, to-dos and calendar as
// context — the same data they can already see — so the assistant can't
// surface anything they don't have access to.
app.get("/api/assistant/status", requireAuth, (req, res) => {
  res.json({ enabled: !!ANTHROPIC_API_KEY });
});

function buildAssistantContext(user) {
  const visible = stateForUser(user.id);
  const lines = [];
  lines.push(`The person you are helping is ${user.displayName || user.username}. Today is ${new Date().toDateString()}.`);

  const boards = visible.boards || [];
  lines.push(`\nBOARDS (${boards.length}):`);
  boards.forEach((b) => {
    const groups = (visible.groups || []).filter((g) => g.boardId === b.id);
    lines.push(`- ${b.name}`);
    groups.forEach((g) => {
      const items = (visible.items || []).filter((i) => i.groupId === g.id && !i.archived);
      if (!items.length) return;
      lines.push(`  Group "${g.name}":`);
      items.forEach((i) => {
        const openSteps = (i.steps || []).filter((st) => !st.done).map((st) => st.text);
        const who = (i.assigneeIds || []).map((id) => { const u = findUserById(id); return u ? (u.displayName || u.username) : null; }).filter(Boolean);
        let line = `    * ${i.title}`;
        if (i.completed) line += " [completed]";
        if (i.priority) line += ` [priority: ${i.priority}]`;
        if (who.length) line += ` [assigned: ${who.join(", ")}]`;
        if (openSteps.length) line += ` [next steps: ${openSteps.join("; ")}]`;
        const notes = (i.notesList || []).map((n) => n.text).join(" | ");
        if (notes) line += ` [notes: ${notes.slice(0, 500)}]`;
        lines.push(line);
      });
    });
  });

  const todos = (visible.todos || []).filter((t) => !t.done);
  if (todos.length) {
    lines.push(`\nACTION ITEMS (open items):`);
    todos.forEach((t) => lines.push(`- ${t.text}`));
  }
  return lines.join("\n");
}

app.post("/api/assistant/chat", requireAuth, async (req, res) => {
  if (!ANTHROPIC_API_KEY) return res.status(503).json({ error: "assistant_not_configured" });
  const user = findUserById(req.session.userId);
  if (!user) return res.status(401).json({ error: "not_authenticated" });
  const history = Array.isArray(req.body && req.body.messages) ? req.body.messages : [];
  if (!history.length) return res.status(400).json({ error: "no_messages" });

  // keep the request small: last 20 turns, each capped
  const messages = history.slice(-20).map((m) => ({
    role: m.role === "assistant" ? "assistant" : "user",
    content: String(m.content || "").slice(0, 8000)
  }));

  // upcoming calendar events, if any calendars are connected
  let calendarText = "";
  try {
    const hidden = hiddenSet(user.id);
    const timeMin = new Date().toISOString();
    const timeMax = new Date(Date.now() + 14 * 86400000).toISOString();
    const evs = [];
    await Promise.all(listAccounts(user.id).map(async (acct) => {
      const a = await freshToken(acct);
      const cals = (await listCalendarsFor(a)).filter((c) => !hidden.has(acct.id + "|" + c.id));
      await Promise.all(cals.map(async (cal) => {
        const list = a.provider === "google"
          ? await fetchGoogleCalendarEvents(a, cal, timeMin, timeMax)
          : await fetchMicrosoftCalendarEvents(a, cal, timeMin, timeMax);
        list.forEach((e) => evs.push(`- ${e.start}${e.allDay ? " (all day)" : ""}: ${e.title}${e.location ? " @ " + e.location : ""}`));
      }));
    }));
    if (evs.length) calendarText = `\n\nCALENDAR (next 14 days):\n` + evs.sort().slice(0, 60).join("\n");
  } catch (e) { /* calendar is optional context */ }

  const system = `You are Claude, built into Avenium Task Manager — a task and calendar app used by a small real-estate team.
Help the user with their work: summarising what's on their plate, drafting messages and notes, thinking through next steps, and answering questions about their tasks and schedule.
Use the context below, which is this user's own data. If something isn't in the context, say so rather than guessing.
Be concise and practical. You cannot change anything in the app yourself — if the user wants something created or edited, tell them briefly where to do it.

${buildAssistantContext(user)}${calendarText}`;

  const payload = JSON.stringify({
    model: ANTHROPIC_MODEL,
    max_tokens: 1500,
    system,
    messages
  });

  try {
    const r = await httpsRequest({
      hostname: "api.anthropic.com", path: "/v1/messages", method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload),
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01"
      }
    }, payload);
    if (r.status >= 300 || !r.body || !r.body.content) {
      const detail = r.body && r.body.error && r.body.error.message;
      return res.status(502).json({ error: detail || "assistant_failed" });
    }
    const text = (r.body.content || []).filter((c) => c.type === "text").map((c) => c.text).join("\n").trim();
    res.json({ reply: text || "(no reply)" });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

server.listen(PORT, () => {
  console.log("Avenium Task Manager running at http://localhost:" + PORT);
});
