# SCAdmin

A private admin panel **and team chat** for a small group of devs, testers and friends: member profiles, crews, per-game stat editing, moderation, cloud saves, and a Slack-style chat with channels, DMs and file sharing.

> Independent hobby project. Not affiliated with, endorsed by, or connected to Rockstar Games. It only manages the accounts and data you create inside your own SCAdmin instance.

Zero dependencies: just Node 20+ (no `npm install`).

## Features

| Area | What it does |
|---|---|
| **Chat** | Channels (`#general`, `#dev`, `#testers`, `#bugs`, `#builds`), private channels, DMs, file/build/screenshot sharing (25 MB), unread badges, edit/delete |
| **Members** | Profile, team tag (Dev / Tester / QA…), linked accounts, admin notes, roles, password reset, sign-out-everywhere |
| **Support Logs** | Per-member audit trail (Profile / Email / Security / Nickname / Password / Stats / Moderation) |
| **StatMaster** | Edit rank, cash, kills etc. per game. A reason is mandatory and every change is logged |
| **Moderation** | Suspend / ban with reason and expiry, flag queue, report from crews |
| **Crews** | Leader + ranks, add/remove, transfer leadership |
| **Cloud Saves** | Upload and download save files per member |
| **Audit log** | Global searchable log of every change |

Add games or stat fields in the `GAMES` array at the top of `server.js`.

## Run it

```bash
node server.js          # http://localhost:8080
```

First run prints a one-time **setup code** in the console. Open the site, enter the code and create the owner account. Then add people from **Members → Add member** and give them a temporary password.

Environment variables: `PORT` (8080), `HOST` (0.0.0.0), `DATA_DIR` (./data), `SETUP_CODE` (use a fixed first-run code on a host where you cannot read the console).

## Hosting on GitHub

**GitHub Pages cannot run this.** Pages only serves static files, and SCAdmin needs a server for logins, chat and uploads. Options:

1. **GitHub Codespaces** (runs the real server on GitHub): *Code -> Codespaces -> Create*. `.devcontainer` starts the server and forwards port 8080. Read the setup code with `cat /tmp/scadmin.log`, open the **Ports** tab, and set port 8080 to **Public** so friends can reach it. Free tier is limited and a Codespace sleeps when idle, so it is for sessions, not 24/7.
2. **Always-on:** connect this repo to a Node host (Render, Railway, Fly.io…): start command `node server.js`, add a persistent disk and set `DATA_DIR` to it, set `SETUP_CODE`.

## Security notes

- Passwords are hashed with scrypt; sessions are HttpOnly + SameSite=Strict cookies; sign-in is rate limited; state-changing calls require a custom header.
- There is no built-in HTTPS. Use a host or tunnel that terminates TLS before exposing it to the internet.
- Everything lives in `data/` (JSON + uploaded files). It is git-ignored: **never commit it**. Back it up yourself.
- Chat is not end-to-end encrypted; the server owner can read everything in it.
