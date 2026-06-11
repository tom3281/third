// ===== Constants =====
const PHASES = {
  LOBBY: "lobby",
  PICK: "pick",     // everyone secretly submits a number 0-100
  REVEAL: "reveal", // average * 2/3 revealed, furthest drinks
};
const MAX_PLAYERS = 10;
const MIN_PLAYERS = 3;
const GRACE_MS = 15_000;
const PICK_MS = 60_000;  // submit window; abstainers drink

// ===== Worker entry =====
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/ws") {
      const room = (url.searchParams.get("room") || "").toUpperCase();
      if (!/^[A-Z0-9]{4,6}$/.test(room)) {
        return new Response("Invalid room code", { status: 400 });
      }
      const id = env.ROOMS.idFromName(room);
      return env.ROOMS.get(id).fetch(request);
    }
    return env.ASSETS.fetch(request);
  },
};

// ===== GameRoom Durable Object =====
export class GameRoom {
  constructor(state, env) {
    this.state = state;
    this.sessions = new Map();
    this.players = new Map(); // playerId -> { name, drinkCount, removeTimer, pick }
    this.phase = PHASES.LOBBY;
    this.hostId = null;
    this.round = 0;
    this.pickDeadline = null; // epoch ms
    this.timers = [];
    this.lastResult = null;
  }

  async fetch(request) {
    if (request.headers.get("upgrade") !== "websocket") {
      return new Response("Expected websocket", { status: 426 });
    }
    const url = new URL(request.url);
    const name = (url.searchParams.get("name") || "").trim().slice(0, 20);
    const clientId = (url.searchParams.get("clientId") || "").trim();
    if (!name) return new Response("Missing name", { status: 400 });
    if (!/^[A-Za-z0-9-]{8,64}$/.test(clientId)) {
      return new Response("Missing or invalid clientId", { status: 400 });
    }

    const existing = this.players.get(clientId);

    let rejectCode = 0;
    let rejectReason = "";
    if (!existing) {
      if (this.players.size >= MAX_PLAYERS) {
        rejectCode = 4030; rejectReason = "Room full";
      } else if (this.phase === PHASES.PICK) {
        // New players can join in LOBBY and between rounds (REVEAL).
        rejectCode = 4023; rejectReason = "Round in progress";
      }
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();

    if (rejectCode) {
      try { server.close(rejectCode, rejectReason); } catch {}
      return new Response(null, { status: 101, webSocket: client });
    }

    if (existing) {
      if (existing.removeTimer) {
        clearTimeout(existing.removeTimer);
        existing.removeTimer = null;
      }
      existing.name = name;
    } else {
      this.players.set(clientId, {
        name,
        drinkCount: 0,
        removeTimer: null,
        pick: null,
      });
      if (!this.hostId) this.hostId = clientId;
    }

    const prior = existing ? this.sessions.get(clientId) : null;
    this.sessions.set(clientId, { ws: server, playerId: clientId });

    server.addEventListener("message", async (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      await this.handleMessage(clientId, msg);
    });
    const onClose = () => {
      const sess = this.sessions.get(clientId);
      if (sess && sess.ws === server) this.handleDisconnect(clientId);
    };
    server.addEventListener("close", onClose);
    server.addEventListener("error", onClose);

    if (prior) {
      try { prior.ws.close(4002, "Replaced by new connection"); } catch {}
    }

    this.broadcast();
    return new Response(null, { status: 101, webSocket: client });
  }

  async handleMessage(playerId, msg) {
    switch (msg.type) {
      case "ping": {
        const sess = this.sessions.get(playerId);
        if (sess) {
          try { sess.ws.send(JSON.stringify({ type: "pong" })); } catch {}
        }
        break;
      }
      case "hello": {
        const sess = this.sessions.get(playerId);
        if (sess) {
          try { sess.ws.send(JSON.stringify(this.viewForPlayer(playerId))); } catch {}
        }
        break;
      }
      case "start":
        if (playerId === this.hostId
            && (this.phase === PHASES.LOBBY || this.phase === PHASES.REVEAL)) {
          if (this.players.size < MIN_PLAYERS) return;
          this.startRound();
        }
        break;
      case "pick": {
        if (this.phase !== PHASES.PICK) return;
        const p = this.players.get(playerId);
        if (!p || p.pick) return; // lock-in is final
        const v = Number(msg.value);
        if (!Number.isInteger(v) || v < 0 || v > 100) return;
        p.pick = { value: v };
        if (this.allPicked()) {
          this.resolveRound();
        } else {
          this.broadcast();
        }
        break;
      }
    }
  }

  handleDisconnect(clientId) {
    this.sessions.delete(clientId);
    const player = this.players.get(clientId);
    if (!player) return;

    if (this.phase === PHASES.LOBBY) {
      this.removePlayer(clientId);
      this.broadcast();
      return;
    }

    if (player.removeTimer) clearTimeout(player.removeTimer);
    player.removeTimer = setTimeout(() => {
      player.removeTimer = null;
      if (this.sessions.has(clientId)) return; // reconnected during grace
      this.removePlayerFromGame(clientId);
    }, GRACE_MS);
    this.broadcast();
  }

  removePlayerFromGame(clientId) {
    this.removePlayer(clientId);
    if (this.players.size < MIN_PLAYERS) {
      this.resetToLobby();
      return;
    }
    if (this.phase === PHASES.PICK && this.allPicked()) {
      this.resolveRound();
      return;
    }
    this.broadcast();
  }

  removePlayer(clientId) {
    this.players.delete(clientId);
    if (this.hostId === clientId) {
      this.hostId = this.players.keys().next().value || null;
    }
  }

  allPicked() {
    for (const p of this.players.values()) {
      if (!p.pick) return false;
    }
    return this.players.size > 0;
  }

  startRound() {
    this.clearTimers();
    this.phase = PHASES.PICK;
    this.round += 1;
    this.pickDeadline = Date.now() + PICK_MS;
    this.lastResult = null;
    for (const p of this.players.values()) p.pick = null;
    this.timers.push(setTimeout(() => {
      if (this.phase === PHASES.PICK) this.resolveRound();
    }, PICK_MS));
    this.broadcast();
  }

  resolveRound() {
    this.clearTimers();

    // Anyone with no pick by now ran out the clock.
    for (const p of this.players.values()) {
      if (!p.pick) p.pick = { abstain: true };
    }

    const submitted = []; // { id, value }
    const abstainIds = [];
    for (const [id, p] of this.players) {
      if (p.pick.abstain) abstainIds.push(id);
      else submitted.push({ id, value: p.pick.value });
    }

    // Target = average * 2/3. Furthest from target drinks 1; closest gets the
    // crown. All-equidistant (e.g. everyone same number) → draw. Fewer than 2
    // numbers → no meaningful target → draw. Abstainers always drink 1.
    const losers = new Set(abstainIds);
    let outcome, avg = null, target = null, entries = [];
    if (submitted.length < 2) {
      outcome = "draw";
      entries = submitted.map(s => ({ ...s, dist: 0, loser: false, crown: false }));
    } else {
      avg = submitted.reduce((sum, s) => sum + s.value, 0) / submitted.length;
      target = avg * 2 / 3;
      entries = submitted.map(s => ({ ...s, dist: Math.abs(s.value - target) }));
      entries.sort((x, y) => x.dist - y.dist);
      const minDist = entries[0].dist;
      const maxDist = entries[entries.length - 1].dist;
      if (maxDist === minDist) {
        outcome = "draw";
        for (const e of entries) { e.loser = false; e.crown = false; }
      } else {
        outcome = "busted";
        for (const e of entries) {
          e.crown = e.dist === minDist;
          e.loser = e.dist === maxDist;
          if (e.loser) losers.add(e.id);
        }
      }
    }
    for (const id of losers) {
      const p = this.players.get(id);
      if (p) p.drinkCount += 1;
    }

    this.phase = PHASES.REVEAL;
    this.pickDeadline = null;
    this.lastResult = {
      round: this.round,
      outcome,                 // "busted" | "draw"
      avg: avg === null ? null : Math.round(avg * 100) / 100,
      target: target === null ? null : Math.round(target * 100) / 100,
      entries: entries.map(e => ({
        id: e.id,
        value: e.value,
        dist: Math.round(e.dist * 100) / 100,
        loser: !!e.loser,
        crown: !!e.crown,
      })),
      abstain: abstainIds,
      losers: [...losers],
    };
    this.broadcast();
  }

  resetToLobby() {
    this.clearTimers();
    this.phase = PHASES.LOBBY;
    this.pickDeadline = null;
    this.lastResult = null;
    for (const p of this.players.values()) p.pick = null;
    this.broadcast();
  }

  clearTimers() {
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
  }

  broadcast() {
    for (const [, session] of this.sessions) {
      try {
        session.ws.send(JSON.stringify(this.viewForPlayer(session.playerId)));
      } catch {}
    }
  }

  viewForPlayer(playerId) {
    const players = [...this.players.entries()].map(([id, p]) => ({
      id,
      name: p.name,
      drinkCount: p.drinkCount,
      isYou: id === playerId,
      // Numbers stay secret until REVEAL — only the fact of submission leaks.
      picked: !!p.pick,
      connected: this.sessions.has(id),
    }));
    const me = this.players.get(playerId);
    return {
      type: "state",
      state: {
        phase: this.phase,
        players,
        hostId: this.hostId,
        you: playerId,
        round: this.round,
        pickDeadline: this.phase === PHASES.PICK ? this.pickDeadline : null,
        myPick: (me && me.pick && typeof me.pick.value === "number") ? me.pick.value : null,
        result: this.phase === PHASES.REVEAL ? this.lastResult : null,
      },
    };
  }
}
