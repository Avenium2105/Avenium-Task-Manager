// Avenium Task Manager — standalone server
// Express serves the frontend and auth; Socket.IO keeps every connected
// browser in sync in real time; state and users persist to local JSON files.

const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const http = require("http");
const express = require("express");
const session = require("express-session");
const bcrypt = require("bcryptjs");
const { Server } = require("socket.io");

const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, "data.json");
const USERS_FILE = path.join(__dirname, "users.json");
const SECRET_FILE = path.join(__dirname, ".session-secret");

const GROUP_COLORS = ["#3C5A46", "#C68A2E", "#7D6BAE", "#4C7A9E", "#B24A3C"];
const DEFAULT_GROUPS = ["Today", "This week", "Someday"];

function uid(prefix) {
  return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
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
  if (fs.existsSync(DATA_FILE)) {
    try {
      const raw = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
      return {
        groups: Array.isArray(raw.groups) ? raw.groups : [],
        items: Array.isArray(raw.items) ? raw.items : [],
        activity: Array.isArray(raw.activity) ? raw.activity : []
      };
    } catch (e) {
      console.error("Could not read data.json, starting fresh:", e.message);
    }
  }
  const now = Date.now();
  return {
    groups: DEFAULT_GROUPS.map((name, i) => ({
      id: "g" + now + "_" + i,
      name,
      color: GROUP_COLORS[i % GROUP_COLORS.length],
      order: i,
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
  state.activity.push({ id: uid("a"), text, at: new Date().toISOString() });
  if (state.activity.length > 200) state.activity = state.activity.slice(-200);
}

// ---------- users ----------

function loadUsers() {
  if (fs.existsSync(USERS_FILE)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(USERS_FILE, "utf8"));
      if (Array.isArray(parsed) && parsed.length > 0) return parsed;
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
    passwordHash: bcrypt.hashSync(tempPassword, 10),
    role: "admin",
    createdAt: new Date().toISOString()
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
  return { id: u.id, username: u.username, displayName: u.displayName, role: u.role, createdAt: u.createdAt };
}

// ---------- app ----------

const app = express();
app.use(express.json());

const sessionMiddleware = session({
  secret: loadOrCreateSecret(),
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 1000 * 60 * 60 * 24 * 30 } // 30 days
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
  if (!u || !bcrypt.compareSync(password, u.passwordHash)) {
    return res.status(401).json({ error: "invalid_credentials" });
  }
  req.session.userId = u.id;
  res.json({ ok: true, user: publicUser(u) });
});

app.post("/api/logout", (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get("/api/me", requireAuth, (req, res) => {
  res.json({ user: publicUser(findUserById(req.session.userId)) });
});

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
app.get("/api/users", requireAuth, requireAdmin, (req, res) => {
  res.json({ users: users.map(publicUser) });
});

app.post("/api/users", requireAuth, requireAdmin, (req, res) => {
  const { username, displayName, password, role } = req.body || {};
  if (!username || !password || String(password).length < 6) return res.status(400).json({ error: "invalid_fields" });
  if (users.some((u) => u.username.toLowerCase() === String(username).toLowerCase())) {
    return res.status(409).json({ error: "username_taken" });
  }
  const newUser = {
    id: uid("u"),
    username: String(username).trim().slice(0, 60),
    displayName: (displayName && String(displayName).trim().slice(0, 100)) || String(username).trim(),
    passwordHash: bcrypt.hashSync(String(password), 10),
    role: role === "admin" ? "admin" : "member",
    createdAt: new Date().toISOString()
  };
  users.push(newUser);
  saveUsers();
  logActivity(`${findUserById(req.session.userId).displayName} created the account "${newUser.username}"`);
  persist();
  res.json({ ok: true, user: publicUser(newUser) });
});

app.put("/api/users/:id", requireAuth, requireAdmin, (req, res) => {
  const u = findUserById(req.params.id);
  if (!u) return res.status(404).json({ error: "not_found" });
  const { displayName, role, password } = req.body || {};
  if (typeof displayName === "string" && displayName.trim()) u.displayName = displayName.trim().slice(0, 100);
  if (role === "admin" || role === "member") {
    if (u.role === "admin" && role !== "admin") {
      const adminCount = users.filter((x) => x.role === "admin").length;
      if (adminCount <= 1) return res.status(400).json({ error: "last_admin" });
    }
    u.role = role;
  }
  if (typeof password === "string" && password.length >= 6) {
    u.passwordHash = bcrypt.hashSync(password, 10);
  }
  saveUsers();
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
  res.json({ ok: true });
});

// ---- activity API ----
app.get("/api/activity", requireAuth, (req, res) => {
  res.json({ activity: state.activity.slice(-60).reverse() });
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

function broadcastState() {
  io.emit("state", state);
}

io.on("connection", (socket) => {
  const user = socketUser(socket);
  if (!user) {
    socket.emit("auth_error");
    socket.disconnect(true);
    return;
  }
  const actorName = () => user.displayName || user.username;

  socket.emit("state", state);
  socket.emit("me", publicUser(user));

  socket.on("addGroup", ({ name }) => {
    if (!name || typeof name !== "string") return;
    const order = state.groups.length;
    state.groups.push({
      id: uid("g"),
      name: name.trim().slice(0, 200) || "Untitled",
      color: GROUP_COLORS[order % GROUP_COLORS.length],
      order,
      createdAt: Date.now(),
      createdBy: actorName()
    });
    logActivity(`${actorName()} added the group "${name.trim()}"`);
    persist();
    broadcastState();
  });

  socket.on("updateGroup", ({ id, patch }) => {
    const g = state.groups.find((x) => x.id === id);
    if (!g || !patch) return;
    if (typeof patch.name === "string") {
      const oldName = g.name;
      g.name = patch.name.trim().slice(0, 200) || "Untitled";
      g.updatedBy = actorName();
      g.updatedAt = new Date().toISOString();
      if (oldName !== g.name) logActivity(`${actorName()} renamed the group "${oldName}" to "${g.name}"`);
    }
    persist();
    broadcastState();
  });

  socket.on("deleteGroup", ({ id }) => {
    const g = state.groups.find((x) => x.id === id);
    if (!g) return;
    state.groups = state.groups.filter((x) => x.id !== id);
    state.items = state.items.filter((i) => i.groupId !== id);
    logActivity(`${actorName()} deleted the group "${g.name}"`);
    persist();
    broadcastState();
  });

  socket.on("addItem", ({ groupId, title, order }) => {
    if (!groupId || !title || typeof title !== "string") return;
    const group = state.groups.find((g) => g.id === groupId);
    if (!group) return;
    const now = new Date().toISOString();
    const item = {
      id: uid("i"),
      groupId,
      title: title.trim().slice(0, 500) || "Untitled task",
      status: "not_started",
      priority: "low",
      dueDate: "",
      order: typeof order === "number" ? order : state.items.length,
      createdAt: Date.now(),
      createdBy: actorName(),
      updatedBy: actorName(),
      updatedAt: now
    };
    state.items.push(item);
    logActivity(`${actorName()} added "${item.title}" to ${group.name}`);
    persist();
    broadcastState();
  });

  socket.on("updateItem", ({ id, patch }) => {
    const item = state.items.find((x) => x.id === id);
    if (!item || !patch) return;
    let changeDesc = null;
    if (typeof patch.title === "string") {
      const t = patch.title.trim().slice(0, 500) || "Untitled task";
      if (t !== item.title) { item.title = t; changeDesc = `renamed a task to "${item.title}"`; }
    }
    if (["not_started", "in_progress", "done"].includes(patch.status) && patch.status !== item.status) {
      item.status = patch.status;
      const labels = { not_started: "not started", in_progress: "in progress", done: "done" };
      changeDesc = `marked "${item.title}" as ${labels[patch.status]}`;
    }
    if (["low", "medium", "high"].includes(patch.priority) && patch.priority !== item.priority) {
      item.priority = patch.priority;
      changeDesc = `set "${item.title}" priority to ${patch.priority}`;
    }
    if (typeof patch.dueDate === "string" && patch.dueDate.slice(0, 10) !== item.dueDate) {
      item.dueDate = patch.dueDate.slice(0, 10);
      changeDesc = item.dueDate ? `set a due date on "${item.title}"` : `cleared the due date on "${item.title}"`;
    }
    if (changeDesc) {
      item.updatedBy = actorName();
      item.updatedAt = new Date().toISOString();
      logActivity(`${actorName()} ${changeDesc}`);
    }
    persist();
    broadcastState();
  });

  socket.on("deleteItem", ({ id }) => {
    const item = state.items.find((x) => x.id === id);
    if (!item) return;
    state.items = state.items.filter((x) => x.id !== id);
    logActivity(`${actorName()} deleted "${item.title}"`);
    persist();
    broadcastState();
  });
});

server.listen(PORT, () => {
  console.log("Avenium Task Manager running at http://localhost:" + PORT);
});
