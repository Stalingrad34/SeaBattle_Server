import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer, createConnection } from "node:net";
import { once } from "node:events";
import { Client } from "colyseus.js";

test("real server: full battle, private patches, validation and duplicate commands", { timeout: 20000 }, async () => {
  const reservation = createServer();
  reservation.listen(0, "127.0.0.1");
  await once(reservation, "listening");
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const child = spawn(process.execPath, ["dist/index.js"], {
    cwd: new URL("..", import.meta.url),
    env: { ...process.env, PORT: String(port) },
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"]
  });
  let output = "";
  child.stdout.on("data", value => output += value);
  child.stderr.on("data", value => output += value);
  const rooms = [];
  try {
    let ready = false;
    for (let attempt = 0; attempt < 60; attempt++) {
      if (child.exitCode !== null) throw new Error(output);
      try {
        await new Promise((resolve, reject) =>
        {
          const socket = createConnection({ port, host: "127.0.0.1" });
          socket.once("connect", () => { socket.destroy(); resolve(); });
          socket.once("error", reject);
        });
        ready = true;
        break;
      } catch { await new Promise(resolve => setTimeout(resolve, 100)); }
    }
    assert.ok(ready, `Server failed to become ready: ${output}`);
    const client = new Client(`ws://127.0.0.1:${port}`);
    const first = await client.create("battle", { BoardSize: 32, ShipLengths: [32] });
    rooms.push(first);
    await waitForState(first, state => state.players?.has(first.sessionId));
    assert.equal(first.state.phase, "waiting");
    assert.equal(first.state.boardSize, 6, "client options must not override server rules");
    const second = await new Client(`ws://127.0.0.1:${port}`).joinById(first.roomId);
    rooms.push(second);
    const battle = [first, second];
    await Promise.all(battle.map(room => waitForState(room, state => state.phase === "playing")));
    for (const room of battle)
    {
      assert.equal(room.state.players.size, 1);
      assert.equal(room.state.players.get(room.sessionId).ownShips.length, 4);
    }
    const send = async (room, command) =>
    {
      const response = receive(room, "commandResult");
      room.send("fire", command);
      return await response;
    };
    for (const invalid of [null, "{", {}, { commandId: "bad", turnId: "1", x: 0, y: 0 }])
    {
      const response = receive(first, "error");
      first.send("fire", invalid);
      assert.equal(await response, "invalid_request");
    }
    const inactive = battle.find(room => room.sessionId !== first.state.activePlayerId);
    const spoofed = { commandId: "wrong-player", turnId: first.state.turnId, x: 0, y: 0, playerId: first.state.activePlayerId };
    assert.equal((await send(inactive, spoofed)).reason, "wrong_turn", "identity must come from the connection");
    const nextCell = new Map(battle.map(room => [room.sessionId, 0]));
    let moves = 0;
    while (first.state.phase !== "finished" && moves < 72)
    {
      const room = battle.find(room => room.sessionId === first.state.activePlayerId);
      const other = battle.find(candidate => candidate !== room);
      const cell = nextCell.get(room.sessionId);
      nextCell.set(room.sessionId, cell + 1);
      const shot = { commandId: `shot-${moves}`, turnId: room.state.turnId, x: cell % 6, y: Math.floor(cell / 6) };
      const result = await send(room, shot);
      assert.equal(result.status, "applied");
      assert.deepEqual(await send(room, shot), result);
      await Promise.all(battle.map(client => waitForState(client, state => state.revision >= result.revision)));
      assert.equal(room.state.players.size, 1);
      assert.equal(other.state.players.size, 1);
      const own = room.state.players.get(room.sessionId);
      const enemy = other.state.players.get(other.sessionId);
      const sent = [...own.outgoingShots].at(-1);
      const received = [...enemy.incomingShots].at(-1);
      assert.deepEqual(sent.toJSON(), received.toJSON());
      const hitShip = [...enemy.ownShips].find(ship => [...ship.cells].some(c => c.x === shot.x && c.y === shot.y));
      assert.equal(sent.result === "miss", !hitShip);
      if (sent.result !== "sunk") assert.equal(sent.sunkCells.length, 0);
      if (room.state.phase === "playing") assert.equal(room.state.activePlayerId, other.sessionId);
      moves++;
    }
    assert.equal(first.state.phase, "finished");
    assert.equal(second.state.winnerId, first.state.winnerId);
    assert.equal(first.state.deadlineMs, 0);
    assert.equal(first.state.activePlayerId, "");
  } finally {
    await Promise.all(rooms.map(room => room.leave()));
    child.kill();
    if (child.exitCode === null) await once(child, "exit");
  }
});

function waitForState(room, predicate) {
  if (predicate(room.state)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { room.onStateChange.remove(listener); reject(new Error("Schema state timeout")); }, 3000);
    const listener = state => {
      if (predicate(state)) { clearTimeout(timeout); room.onStateChange.remove(listener); resolve(); }
    };
    room.onStateChange(listener);
  });
}

function receive(room, type) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`No ${type} received`)), 3000);
    room.onMessage(type, message => { clearTimeout(timeout); resolve(message); });
  });
}
