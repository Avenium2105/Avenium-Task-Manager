// Daily Board — standalone server
// Express serves the frontend; Socket.IO keeps every connected browser
// in sync in real time; state is persisted to a local JSON file.

const path = require("path");
const fs = require("fs");
const http = require("http");
const express = require("express");
const { Server } = require("socket.io");

const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, "data.json");

const GROUP_COLORS = ["#3C5A46", "#C68A2E", "#7D6BAE", "#4C7A9E", "#B24A3C"];
const DEFAULT_GROUPS = ["Today", "This week", "Someday"];

// ---------- persistence ----------

function loadState() {
  if (fs.existsSync(DATA_FILE)) {
    try {
      const raw = fs.readFileSync(DATA_FILE, "utf8");
      const parsed = JSON.parse(raw);
      if (parsed && Array.isArray(parsed.groups) && Array.isArray(parsed.items)) {
        return parsed;
      }
    } catch (e) {
      console.error("Could not read data.json, starting fresh:", e.message);
    }
  }
  // First run: seed default groups, no items.
  const now = Date.now();
  return {
    groups: DEFAULT_GROUPS.map((name, i) => ({
      id: "g" + now + "_" + i,
      name,
      color: GROUP_COLORS[i % GROUP_COLORS.length],
      order: i,
      createdAt: now
    })),
    items: []
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
  }, 150); // small debounce so rapid edits don't hammer the disk
}

function uid(prefix) {
  return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// ---------- app ----------

const app = express();
app.use(express.static(path.join(__dirname, "public")));

const server = http.createServer(app);
const io = new Server(server);

function broadcastState() {
  io.emit("state", state);
}

io.on("connection", (socket) => {
  socket.emit("state", state);

  socket.on("addGroup", ({ name }) => {
    if (!name || typeof name !== "string") return;
    const order = state.groups.length;
    state.groups.push({
      id: uid("g"),
      name: name.trim().slice(0, 200) || "Untitled",
      color: GROUP_COLORS[order % GROUP_COLORS.length],
      order,
      createdAt: Date.now()
    });
    persist();
    broadcastState();
  });

  socket.on("updateGroup", ({ id, patch }) => {
    const g = state.groups.find((x) => x.id === id);
    if (!g || !patch) return;
    if (typeof patch.name === "string") g.name = patch.name.trim().slice(0, 200) || "Untitled";
    persist();
    broadcastState();
  });

  socket.on("deleteGroup", ({ id }) => {
    state.groups = state.groups.filter((g) => g.id !== id);
    state.items = state.items.filter((i) => i.groupId !== id);
    persist();
    broadcastState();
  });

  socket.on("addItem", ({ groupId, title, order }) => {
    if (!groupId || !title || typeof title !== "string") return;
    if (!state.groups.some((g) => g.id === groupId)) return;
    state.items.push({
      id: uid("i"),
      groupId,
      title: title.trim().slice(0, 500) || "Untitled task",
      status: "not_started",
      priority: "low",
      dueDate: "",
      order: typeof order === "number" ? order : state.items.length,
      createdAt: Date.now()
    });
    persist();
    broadcastState();
  });

  socket.on("updateItem", ({ id, patch }) => {
    const item = state.items.find((x) => x.id === id);
    if (!item || !patch) return;
    if (typeof patch.title === "string") item.title = patch.title.trim().slice(0, 500) || "Untitled task";
    if (["not_started", "in_progress", "done"].includes(patch.status)) item.status = patch.status;
    if (["low", "medium", "high"].includes(patch.priority)) item.priority = patch.priority;
    if (typeof patch.dueDate === "string") item.dueDate = patch.dueDate.slice(0, 10);
    persist();
    broadcastState();
  });

  socket.on("deleteItem", ({ id }) => {
    state.items = state.items.filter((i) => i.id !== id);
    persist();
    broadcastState();
  });
});

server.listen(PORT, () => {
  console.log("Daily Board running at http://localhost:" + PORT);
});
