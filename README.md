# Yahzms Online

Five dice. Thirteen rounds. Nae scrubs.

Online multiplayer Yahtzee for 2–4 players. No sign-in — everyone opens the
same URL, enters their initials, and plays from their own device. The first
player to join is the host and starts the game.

## How it works

- Node.js server (Express + WebSockets) holds the authoritative game state —
  dice rolls and scoring are validated server-side.
- All players see rolls, holds, and scores update live.
- Refreshing the page reconnects you to your seat mid-game.
- One shared table per server. When a game ends, "Play Again" returns
  everyone to the lobby.

## Run locally

```bash
npm install
npm start
```

Then open http://localhost:3000 in two or more browser windows.

## Deploy to Render

1. Push this repo to GitHub.
2. On [Render](https://render.com): **New → Blueprint**, connect the repo.
   `render.yaml` configures the free-tier Node web service automatically.
3. Share the resulting URL with your players.

Note: on the free tier, Render spins the server down after ~15 minutes of
inactivity. The first visit after that takes ~30–60 seconds to wake up, and
any game in progress is lost (state is in memory only).
