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

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || __dirname;
const DATA_FILE = path.join(DATA_DIR, "data.json");
const USERS_FILE = path.join(DATA_DIR, "users.json");
const SECRET_FILE = path.join(DATA_DIR, ".session-secret");
const UPLOADS_DIR = path.join(DATA_DIR, "uploads");
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(UPLOADS_DIR, { recursive: true });
const PUBLIC_URL = process.env.PUBLIC_URL || "";

const GROUP_COLORS = ["#3C5A46", "#C68A2E", "#7D6BAE", "#4C7A9E", "#B24A3C"];
const DEFAULT_GROUPS = ["Today", "This week", "Someday"];
const MAX_FILE_BYTES = 20 * 1024 * 1024; // 20MB per file

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
        return migrated;
      });
      return {
        boards, groups, items,
        activity: Array.isArray(raw.activity) ? raw.activity : [],
        messages: Array.isArray(raw.messages) ? raw.messages : []
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
    messages: []
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

// ---- shared nav bar (used by both index.html and users.html) ----
// This was the actual reason the nav bar never showed up, no matter how many
// times the page was hard-refreshed: nothing in this file ever served these
// two files, so every request for them 404'd and the browser silently gave
// up on both the <script src="/nav.js"> and <link rel="stylesheet" href="/nav.css">
// tags. Nav bar content and layout are just missing on the page in that case
// — not a caching issue, so no amount of refreshing could have fixed it.
app.get("/nav.js", (req, res) => res.sendFile(path.join(__dirname, "public", "nav.js")));
app.get("/nav.css", (req, res) => res.sendFile(path.join(__dirname, "public", "nav.css")));

// ---- pages ----
app.get("/login.html", (req, res) => res.sendFile(path.join(__dirname, "public", "login.html")));
app.get(["/", "/index.html"], requireAuth, (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));
// Admin is now a client-side view inside index.html itself (see the router in
// its <script>), not a separate page — this serves the very same file. Direct
// visits, refreshes, and bookmarks all still work: requireAdmin gates it here
// server-side exactly as it did for the old standalone users.html, and the
// page's own JS reads the "/admin" URL on load to show the right view.
// /users.html is kept as a redirect so any existing bookmarks still land
// somewhere sensible instead of 404ing.
app.get("/admin", requireAuth, requireAdmin, (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));
app.get("/users.html", (req, res) => res.redirect(301, "/admin"));
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
  return { boards: visibleBoards, groups: visibleGroups, items: visibleItems, activity: state.activity, messages: visibleMessages };
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
      id: uid("b"), name: name.trim().slice(0, 100) || "Untitled board",
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
    board.name = name.trim().slice(0, 100);
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
      id: uid("g"), boardId, name: name.trim().slice(0, 200) || "Untitled",
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
      g.name = patch.name.trim().slice(0, 200) || "Untitled";
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
      notes: "", priority: "low",
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
      id: uid("s"), text: String(text).trim().slice(0, 1000), done: false,
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
    step.text = text.trim().slice(0, 1000);
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

server.listen(PORT, () => {
  console.log("Avenium Task Manager running at http://localhost:" + PORT);
});
