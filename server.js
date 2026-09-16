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
const { Server } = require("socket.io");
const nodemailer = require("nodemailer");

const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, "data.json");
const USERS_FILE = path.join(__dirname, "users.json");
const SECRET_FILE = path.join(__dirname, ".session-secret");
const PUBLIC_URL = process.env.PUBLIC_URL || "";

const GROUP_COLORS = ["#3C5A46", "#C68A2E", "#7D6BAE", "#4C7A9E", "#B24A3C"];
const DEFAULT_GROUPS = ["Today", "This week", "Someday"];
const STATUSES = ["not_started", "next_step", "in_progress", "done"];
const STATUS_LABELS = { not_started: "Not started", next_step: "Next step", in_progress: "In progress", done: "Completed" };

function uid(prefix) {
  return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}
function nowIso() { return new Date().toISOString(); }

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
  const defaultBoard = { id: "b" + now, name: "General", order: 0, createdAt: now };

  if (fs.existsSync(DATA_FILE)) {
    try {
      const raw = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
      const boards = Array.isArray(raw.boards) && raw.boards.length ? raw.boards : [defaultBoard];
      const firstBoardId = boards[0].id;
      const groups = (Array.isArray(raw.groups) ? raw.groups : []).map((g) => ({
        visibility: "shared",
        boardId: firstBoardId,
        ...g
      }));
      const items = (Array.isArray(raw.items) ? raw.items : []).map((i) => ({
        assigneeId: null,
        notes: "",
        ...i
      }));
      return { boards, groups, items, activity: Array.isArray(raw.activity) ? raw.activity : [] };
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
    activity: []
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

// ---------- users ----------

function loadUsers() {
  if (fs.existsSync(USERS_FILE)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(USERS_FILE, "utf8"));
      if (Array.isArray(parsed) && parsed.length > 0) return parsed.map((u) => ({ email: "", ...u }));
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
    passwordHash: bcrypt.hashSync(tempPassword, 10),
    role: "admin",
    createdAt: nowIso()
  }];
  saveUsers();
  console.log("=================================================");
  console.log(" First run: created an admin account.");
  console.log("   username: admin");
  console.log("   password: " + tempPassword);
  console.log(" Log in with this, then add your other users from");
  console.log(" the \"Manage users\" page, and change this password.");
  console.log("=================================================");
}

function findUserById(id) { return users.find((u) => u.id === id); }
function publicUser(u) {
  return { id: u.id, username: u.username, displayName: u.displayName, email: u.email || "", role: u.role, createdAt: u.createdAt };
}
function teamMember(u) { return { id: u.id, displayName: u.displayName }; }
function broadcastTeam() { io.emit("team", users.map(teamMember)); }

// ---------- email (optional — configured via environment variables) ----------

const SMTP_HOST = process.env.SMTP_HOST || "smtp.office365.com";
const SMTP_PORT = Number(process.env.SMTP_PORT || 587);
const IMAP_HOST = process.env.IMAP_HOST || "outlook.office365.com";
const IMAP_PORT = Number(process.env.IMAP_PORT || 993);
const EMAIL_USER = process.env.EMAIL_USER || "";
const EMAIL_PASS = process.env.EMAIL_PASS || "";
const EMAIL_SEND_ENABLED = !!(EMAIL_USER && EMAIL_PASS);
const EMAIL_RECEIVE_ENABLED = EMAIL_SEND_ENABLED && process.env.EMAIL_RECEIVE !== "off";

let mailer = null;
if (EMAIL_SEND_ENABLED) {
  mailer = nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: false,
    auth: { user: EMAIL_USER, pass: EMAIL_PASS }
  });
  console.log("Email sending is ON via " + SMTP_HOST + " as " + EMAIL_USER);
} else {
  console.log("Email sending is OFF — set EMAIL_USER and EMAIL_PASS to enable it.");
}

function sendMail(to, subject, text) {
  if (!mailer || !to) return Promise.resolve(false);
  return mailer.sendMail({ from: EMAIL_USER, to, subject, text })
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
    status: "not_started", priority: "low", dueDate: "",
    assigneeId: matchedUser ? matchedUser.id : null,
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
      auth: { user: EMAIL_USER, pass: EMAIL_PASS }, logger: false
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
  console.log("Email receiving is ON via " + IMAP_HOST + " (checked every 2 minutes)");
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
  return res.redirect("/login.html");
}
function requireAdmin(req, res, next) {
  const u = req.session && findUserById(req.session.userId);
  if (u && u.role === "admin") return next();
  if (req.path.startsWith("/api/")) return res.status(403).json({ error: "forbidden" });
  return res.redirect("/");
}

// ---- pages ----
app.get("/login.html", (req, res) => res.sendFile(path.join(__dirname, "public", "login.html")));
app.get(["/", "/index.html"], requireAuth, (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));
app.get("/users.html", requireAuth, requireAdmin, (req, res) => res.sendFile(path.join(__dirname, "public", "users.html")));

// ---- auth API ----
app.post("/api/login", (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: "missing_fields" });
  const u = users.find((x) => x.username.toLowerCase() === String(username).toLowerCase());
  if (!u || !bcrypt.compareSync(password, u.passwordHash)) return res.status(401).json({ error: "invalid_credentials" });
  req.session.userId = u.id;
  res.json({ ok: true, user: publicUser(u) });
});
app.post("/api/logout", (req, res) => { req.session.destroy(() => res.json({ ok: true })); });
app.get("/api/me", requireAuth, (req, res) => res.json({ user: publicUser(findUserById(req.session.userId)) }));
app.get("/api/team", requireAuth, (req, res) => res.json({ team: users.map(teamMember) }));

app.post("/api/change-password", requireAuth, (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  const u = findUserById(req.session.userId);
  if (!newPassword || String(newPassword).length < 6) return res.status(400).json({ error: "weak_password" });
  if (!bcrypt.compareSync(currentPassword || "", u.passwordHash)) return res.status(401).json({ error: "wrong_current_password" });
  u.passwordHash = bcrypt.hashSync(newPassword, 10);
  saveUsers();
  res.json({ ok: true });
});

// ---- user management API (admin only) ----
app.get("/api/users", requireAuth, requireAdmin, (req, res) => res.json({ users: users.map(publicUser) }));

app.post("/api/users", requireAuth, requireAdmin, (req, res) => {
  const { username, displayName, email, password, role } = req.body || {};
  if (!username || !password || String(password).length < 6) return res.status(400).json({ error: "invalid_fields" });
  if (users.some((u) => u.username.toLowerCase() === String(username).toLowerCase())) return res.status(409).json({ error: "username_taken" });
  const newUser = {
    id: uid("u"),
    username: String(username).trim().slice(0, 60),
    displayName: (displayName && String(displayName).trim().slice(0, 100)) || String(username).trim(),
    email: (email && String(email).trim().slice(0, 200)) || "",
    passwordHash: bcrypt.hashSync(String(password), 10),
    role: role === "admin" ? "admin" : "member",
    createdAt: nowIso()
  };
  users.push(newUser);
  saveUsers();
  logActivity(`${findUserById(req.session.userId).displayName} created the account "${newUser.username}"`);
  persist();
  broadcastTeam();
  res.json({ ok: true, user: publicUser(newUser) });
});

app.put("/api/users/:id", requireAuth, requireAdmin, (req, res) => {
  const u = findUserById(req.params.id);
  if (!u) return res.status(404).json({ error: "not_found" });
  const { displayName, email, role, password } = req.body || {};
  if (typeof displayName === "string" && displayName.trim()) u.displayName = displayName.trim().slice(0, 100);
  if (typeof email === "string") u.email = email.trim().slice(0, 200);
  if (role === "admin" || role === "member") {
    if (u.role === "admin" && role !== "admin") {
      const adminCount = users.filter((x) => x.role === "admin").length;
      if (adminCount <= 1) return res.status(400).json({ error: "last_admin" });
    }
    u.role = role;
  }
  if (typeof password === "string" && password.length >= 6) u.passwordHash = bcrypt.hashSync(password, 10);
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
  const visibleGroups = state.groups.filter((g) => g.visibility !== "private" || g.ownerId === userId);
  const visibleGroupIds = new Set(visibleGroups.map((g) => g.id));
  const visibleItems = state.items.filter((i) => visibleGroupIds.has(i.groupId));
  return { boards: state.boards, groups: visibleGroups, items: visibleItems, activity: state.activity };
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
    return g && (g.visibility !== "private" || g.ownerId === user.id);
  }

  socket.emit("state", stateForUser(user.id));
  socket.emit("me", publicUser(user));
  socket.emit("team", users.map(teamMember));

  // ---- boards ----
  socket.on("addBoard", ({ name }) => {
    if (!name || typeof name !== "string") return;
    const board = { id: uid("b"), name: name.trim().slice(0, 100) || "Untitled board", order: state.boards.length, createdAt: Date.now(), createdBy: actorName() };
    state.boards.push(board);
    logActivity(`${actorName()} created the board "${board.name}"`);
    persist();
    broadcastState();
  });

  // ---- groups ----
  socket.on("addGroup", ({ name, boardId, visibility }) => {
    if (!name || typeof name !== "string") return;
    if (!state.boards.some((b) => b.id === boardId)) return;
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
    persist();
    broadcastState();
  });

  socket.on("deleteGroup", ({ id }) => {
    const g = groupById(id);
    if (!g || !canTouchGroup(g)) return;
    state.groups = state.groups.filter((x) => x.id !== id);
    state.items = state.items.filter((i) => i.groupId !== id);
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
      title: title.trim().slice(0, 500) || "Untitled task",
      notes: "", status: "not_started", priority: "low", dueDate: "",
      assigneeId: null,
      order: typeof order === "number" ? order : state.items.length,
      createdAt: Date.now(), createdBy: actorName(), updatedBy: actorName(), updatedAt: nowIso()
    };
    state.items.push(item);
    if (group.visibility !== "private") logActivity(`${actorName()} added "${item.title}" to ${group.name}`);
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
      const t = patch.title.trim().slice(0, 500) || "Untitled task";
      if (t !== item.title) { item.title = t; changeDesc = `renamed a task to "${item.title}"`; }
    }
    if (STATUSES.includes(patch.status) && patch.status !== item.status) {
      item.status = patch.status;
      changeDesc = `marked "${item.title}" as ${STATUS_LABELS[patch.status].toLowerCase()}`;
    }
    if (["low", "medium", "high"].includes(patch.priority) && patch.priority !== item.priority) {
      item.priority = patch.priority;
      changeDesc = `set "${item.title}" priority to ${patch.priority}`;
    }
    if (typeof patch.dueDate === "string" && patch.dueDate.slice(0, 10) !== item.dueDate) {
      item.dueDate = patch.dueDate.slice(0, 10);
      changeDesc = item.dueDate ? `set a due date on "${item.title}"` : `cleared the due date on "${item.title}"`;
    }
    if (typeof patch.notes === "string" && patch.notes !== item.notes) {
      item.notes = patch.notes.slice(0, 2000);
      changeDesc = `updated the notes on "${item.title}"`;
    }
    if ("assigneeId" in patch && patch.assigneeId !== item.assigneeId) {
      item.assigneeId = patch.assigneeId || null;
      const assignee = item.assigneeId ? findUserById(item.assigneeId) : null;
      changeDesc = assignee ? `assigned "${item.title}" to ${assignee.displayName}` : `unassigned "${item.title}"`;
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
    state.items = state.items.filter((x) => x.id !== id);
    if (group.visibility !== "private") logActivity(`${actorName()} deleted "${item.title}"`);
    persist();
    broadcastState();
  });

  // ---- notify assignee it's their turn ----
  socket.on("notifyTurn", async ({ itemId }) => {
    const item = state.items.find((x) => x.id === itemId);
    if (!item || !item.assigneeId) return;
    const group = groupById(item.groupId);
    if (!canTouchGroup(group)) return;
    const assignee = findUserById(item.assigneeId);
    if (!assignee) return;
    if (group.visibility !== "private") logActivity(`${actorName()} notified ${assignee.displayName} that it's their turn on "${item.title}"`);
    persist();
    broadcastState();
    if (assignee.email) {
      const link = PUBLIC_URL ? ("\n\nOpen the board: " + PUBLIC_URL) : "";
      await sendMail(assignee.email, `It's your turn: ${item.title}`, `${actorName()} says it's your turn on "${item.title}".${link}`);
    }
  });
});

server.listen(PORT, () => {
  console.log("Avenium Task Manager running at http://localhost:" + PORT);
});
