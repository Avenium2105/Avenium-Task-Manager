# Avenium Task Manager

A small, shared, real-time daily task board — like a mini Monday.com — built to
run as your own standalone app. It has no dependency on any third-party
account: it's a self-contained Node.js server, so anyone you give the link to
can open it and see the same board update live.

## What's inside

- `server.js` — an Express server that also runs Socket.IO, so every
  connected browser gets updates the instant anyone adds, checks off, or
  edits a task.
- `public/index.html` — the whole frontend (no build step, no framework).
- `data.json` — created automatically the first time someone changes
  something. This is where all your groups and tasks live. Back this file up
  if you care about the data — it's the entire database.

## Run it locally

You'll need [Node.js](https://nodejs.org) 18 or newer installed.

```bash
npm install
npm start
```

Then open **http://localhost:3000**. Anyone on the same Wi-Fi/network can
also reach it at `http://<your-computer's-local-IP>:3000`, but for your 3
users to reach it from anywhere, you'll want to deploy it (next section).

## Put it online for your 3 users

The simplest free options, in order of how easy they are to set up:

### Option A — Render.com (recommended, free tier)
1. Push this folder to a GitHub repo (or use Render's "public Git repo" URL if you don't want your own repo).
2. On [render.com](https://render.com), click **New → Web Service**, connect the repo.
3. Build command: `npm install`. Start command: `npm start`.
4. Deploy. Render gives you a public URL like `https://daily-board.onrender.com` — share that with your 3 users.
5. **Important:** Render's free tier has an *ephemeral* filesystem — `data.json` will reset if the service restarts or spins down from inactivity. For a free tier you're testing with, that's fine; if you want the data to actually stick, add a persistent disk (Render's paid "Disks" add-on, a few dollars/month) mounted at `/opt/render/project/src`, or swap in a small hosted database later.

### Option B — Railway.app or Fly.io
Similar flow to Render: connect the repo (or `fly launch` / `railway up` from this folder), both have small free/trial tiers, and both offer persistent volumes if you want the data to survive restarts.

### Option C — Your own VPS (most control)
Any $4–6/month VPS (DigitalOcean, Linode, Hetzner) works well since the disk is always persistent there:
```bash
git clone <your repo>
cd daily-board-app
npm install
npm start   # or run it under pm2 / a systemd service so it survives reboots
```
Put it behind a reverse proxy (Caddy or nginx) if you want a real domain name and HTTPS — Caddy makes this a one-line config.

## Accounts and logins

The app now requires signing in. The first time it starts, it creates one **admin** account automatically and prints the username and a random temporary password to the server logs (in Render, check the **Logs** tab; locally, check your terminal). It looks like:

```
 First run: created an admin account.
   username: admin
   password: 8c89f27a
```

Sign in with that, then go to **Manage users** (linked in the top bar) to add your other 2 people and change your own password. Each account can:
- change its own password (top bar → "Change password")
- an **admin** account can also add, edit, or remove other accounts from the Manage users page

Every task and group shows who last added or updated it, and the Manage users page has a running activity log of every change with a timestamp.

**Important:** `users.json` (accounts) and `data.json` (tasks) are excluded from git on purpose since they hold real passwords and data — don't remove them from `.gitignore`. This also means, on a free Render instance with no persistent disk, **both your tasks and your accounts will reset if the service restarts.** If you're using this for real, set up a persistent disk (see the deployment section above) so accounts and tasks survive restarts — otherwise you'll need to re-create the admin account (and re-add the other 2 users) after every restart.

It's also worth setting a fixed `SESSION_SECRET` environment variable in Render (Settings → Environment) to a long random string — otherwise a restart also signs everyone out even if the disk is persistent.

## Notes

- All 3 people can be editing at the same time; the last change to a given task wins, same as most lightweight shared tools.
