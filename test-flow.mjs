// Smoke test: 4 players.
// Round 1 = picks 0/30/60/90 → avg 45, target 30 → 90 drinks, 30 gets crown.
//           + pick secrecy check + invalid pick rejection.
// Round 2 = everyone picks 50 → all equidistant → draw, nobody drinks.
// Usage: node test-flow.mjs [port]
const PORT = process.argv[2] || "8791";
const ROOM = "TEST1";

function client(name, id) {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?room=${ROOM}&name=${name}&clientId=${id}`);
  const c = { name, id, ws, state: null };
  ws.addEventListener("open", () => ws.send(JSON.stringify({ type: "hello" })));
  ws.addEventListener("message", (e) => {
    const msg = JSON.parse(e.data);
    if (msg.type === "state") c.state = msg.state;
  });
  ws.addEventListener("close", (e) => console.log(`[${name}] closed ${e.code} ${e.reason}`));
  return c;
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function waitFor(fn, desc, timeout = 12000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    if (fn()) return;
    await sleep(50);
  }
  throw new Error("timeout waiting for: " + desc);
}

const a = client("Alice", "aaaaaaaa-test-0001");
const b = client("Bob", "bbbbbbbb-test-0002");
const c = client("Carol", "cccccccc-test-0003");
const d = client("Dave", "dddddddd-test-0004");
const all = [a, b, c, d];

await waitFor(() => all.every(x => x.state && x.state.players.length === 4), "all in lobby");
console.log("LOBBY OK — host:", a.state.hostId);
const host = all.find(x => x.state.you === x.state.hostId);

// ===== Round 1 =====
host.ws.send(JSON.stringify({ type: "start" }));
await waitFor(() => all.every(x => x.state.phase === "pick" && x.state.pickDeadline), "pick phase 1");
console.log("PICK OK — deadline:", a.state.pickDeadline);

// Invalid picks must be ignored.
a.ws.send(JSON.stringify({ type: "pick", value: 101 }));
a.ws.send(JSON.stringify({ type: "pick", value: -5 }));
a.ws.send(JSON.stringify({ type: "pick", value: 33.5 }));
a.ws.send(JSON.stringify({ type: "pick", value: "abc" }));
await sleep(300);
if (a.state.myPick !== null) throw new Error("invalid picks should be rejected");
console.log("VALIDATION OK — out-of-range/non-integer picks ignored");

a.ws.send(JSON.stringify({ type: "pick", value: 0 }));
await waitFor(() => b.state.players.find(p => p.id === a.id)?.picked, "Alice picked flag visible");
// Secrecy: Bob must see THAT Alice picked, but not WHAT.
const aliceFromBob = b.state.players.find(p => p.id === a.id);
if ("value" in aliceFromBob || "pick" in aliceFromBob) throw new Error("pick value leaked during PICK phase");
if (b.state.myPick !== null) throw new Error("Bob should have no myPick yet");
console.log("SECRECY OK — picked flag visible, value hidden");

// Second pick from Alice must be ignored (lock-in is final).
a.ws.send(JSON.stringify({ type: "pick", value: 99 }));
await sleep(300);
if (a.state.myPick !== 0) throw new Error("pick should be immutable after lock-in");
console.log("LOCK OK — second pick ignored");

b.ws.send(JSON.stringify({ type: "pick", value: 30 }));
c.ws.send(JSON.stringify({ type: "pick", value: 60 }));
d.ws.send(JSON.stringify({ type: "pick", value: 90 }));

await waitFor(() => all.every(x => x.state.phase === "reveal" && x.state.result), "reveal 1");
const r1 = a.state.result;
console.log("RESULT 1: avg =", r1.avg, "target =", r1.target,
  r1.entries.map(e => `${e.value}(d=${e.dist}${e.crown ? ",👑" : ""}${e.loser ? ",🍺" : ""})`).join(" "));
if (r1.avg !== 45 || r1.target !== 30) throw new Error("avg/target math wrong");
if (r1.entries[0].value !== 30 || !r1.entries[0].crown) throw new Error("30 should be closest and crowned");
const loserEntry = r1.entries.find(e => e.loser);
if (!loserEntry || loserEntry.value !== 90) throw new Error("90 should be the sole loser");
const daveP = a.state.players.find(p => p.id === d.id);
if (daveP.drinkCount !== 1) throw new Error("Dave should have 1 drink");
if (a.state.players.filter(p => p.drinkCount === 0).length !== 3) throw new Error("only Dave should drink");
console.log("ROUND 1 OK — furthest drinks, closest crowned");

// ===== Round 2: all same number → draw =====
host.ws.send(JSON.stringify({ type: "start" }));
await waitFor(() => all.every(x => x.state.phase === "pick" && x.state.round === 2), "pick phase 2");
for (const x of all) x.ws.send(JSON.stringify({ type: "pick", value: 50 }));

await waitFor(() => all.every(x => x.state.phase === "reveal" && x.state.result.round === 2), "reveal 2");
const r2 = a.state.result;
console.log("RESULT 2:", r2.outcome, "losers:", r2.losers.length);
if (r2.outcome !== "draw") throw new Error("all-same picks should be a draw");
if (r2.losers.length !== 0) throw new Error("draw should have no losers");
const daveP2 = a.state.players.find(p => p.id === d.id);
if (daveP2.drinkCount !== 1) throw new Error("drink counts should persist across rounds");
console.log("ROUND 2 OK — draw, no extra drinks");

console.log("\nALL TESTS PASSED");
for (const x of all) x.ws.close(1000);
process.exit(0);
