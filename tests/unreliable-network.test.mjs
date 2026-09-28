import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { Server } from "@colyseus/core";
import { WebSocketTransport } from "@colyseus/ws-transport";
import { Client } from "colyseus.js";
import { BattleRoom } from "../dist/rooms/BattleRoom.js";

function random(seed)
{
  return () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
}

class SeededRoom extends BattleRoom
{
  static current;
  onCreate(options)
  {
    const previous = Math.random;
    Math.random = random(options.seed);
    try
    {
      // BattleGame captures this RNG in its constructor; production code is unchanged.
      super.onCreate(options);
    }
    finally
    {
      Math.random = previous;
    }
    SeededRoom.current = this;
  }
}

class UnreliableClient
{
  constructor(room, seed)
  {
    this.room = room;
    this.random = random(seed);
    this.view = null;
    this.results = new Map();
    this.timers = new Set();
    this.drops = 0;
    this.duplicates = 0;
    room.onMessage("commandResult", result => this.deliver(result, value => this.results.set(value.commandId, value)));
    room.onStateChange(() => this.snapshot());
    // Like the Unity heartbeat checkpoint: lost last state must eventually be repaired.
    this.checkpoint = setInterval(() => this.snapshot(), 70);
    this.snapshot();
  }

  deliver(message, receive)
  {
    if (this.random() < 0.25)
    {
      this.drops++;
      return;
    }
    const copies = this.random() < 0.4 ? 2 : 1;
    this.duplicates += copies - 1;
    for (let copy = 0; copy < copies; copy++)
    {
      // Serialization and independent data prevent live Schema mutation from bypassing delay.
      const wire = JSON.stringify(message);
      const timer = setTimeout(() =>
      {
        this.timers.delete(timer);
        receive(JSON.parse(wire));
      }, 5 + Math.floor(this.random() * 45));
      this.timers.add(timer);
    }
  }

  snapshot()
  {
    if (!this.room.state.players?.has(this.room.sessionId)) return;
    this.deliver(this.room.state.toJSON(), state =>
    {
      assert.deepEqual(Object.keys(state.players), [this.room.sessionId], "private state leaked");
      if (!this.view || state.revision > this.view.revision) this.view = state;
    });
  }

  async fire(command)
  {
    const send = () => this.deliver(command, value => this.room.send("fire", value));
    send();
    const retry = setInterval(send, 90);
    try
    {
      await until(() => this.results.has(command.commandId) && this.view.revision >= this.results.get(command.commandId).revision);
      return this.results.get(command.commandId);
    }
    finally
    {
      clearInterval(retry);
    }
  }

  close()
  {
    clearInterval(this.checkpoint);
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
  }
}

async function until(predicate)
{
  const end = Date.now() + 5000;
  while (!predicate())
  {
    assert.ok(Date.now() < end, "network convergence timeout");
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

test("full real battles converge with 25% loss, 40% duplicates and reordered delivery", { timeout: 90000 }, async t =>
{
  const http = createServer();
  const server = new Server({ transport: new WebSocketTransport({ server: http }), greet: false });
  server.define("battle", SeededRoom);
  await server.listen(0, "127.0.0.1");
  const client = new Client(`ws://127.0.0.1:${http.address().port}`);
  try
  {
    for (const seed of [7, 42, 2026])
    {
      await t.test(`seed ${seed}`, { timeout: 28000 }, async () =>
      {
        const rooms = [];
        const bots = [];
        try
        {
          rooms.push(await client.create("battle", { roomName: `LOSS${String(seed).padStart(4, "0")}`, seed }));
          rooms.push(await client.joinById(rooms[0].roomId));
          rooms.forEach((room, i) => bots.push(new UnreliableClient(room, seed + i)));
          await until(() => bots.every(bot => bot.view?.phase === "playing"));
          const authoritative = SeededRoom.current.state;
          let moves = 0;
          while (authoritative.phase !== "finished")
          {
            assert.ok(moves++ < 73, "battle must finish within board capacity");
            await until(() => bots.every(bot => bot.view.revision === authoritative.revision));
            const bot = bots.find(candidate => candidate.room.sessionId === authoritative.activePlayerId);
            const own = bot.view.players[bot.room.sessionId];
            let cell = 0;
            while (own.outgoingShots.some(shot => shot.x === cell % 6 && shot.y === Math.floor(cell / 6))) cell++;
            const command = { commandId: `seed-${seed}-move-${moves}`, turnId: bot.view.turnId, x: cell % 6, y: Math.floor(cell / 6) };
            const result = await bot.fire(command);
            assert.equal(result.status, "applied");
            assert.equal(authoritative.players.get(bot.room.sessionId).outgoingShots.length, own.outgoingShots.length + 1);
          }
          await until(() => bots.every(bot => bot.view.phase === "finished"));
          for (const bot of bots)
          {
            const expected = authoritative.toJSON();
            expected.players = { [bot.room.sessionId]: expected.players[bot.room.sessionId] };
            assert.deepEqual(bot.view, expected, "client differs from authoritative private state");
            assert.ok(bot.drops > 0 && bot.duplicates > 0, "bad network must actually be exercised");
            const shots = bot.view.players[bot.room.sessionId].outgoingShots;
            assert.equal(new Set(shots.map(shot => `${shot.x},${shot.y}`)).size, shots.length);
          }
        }
        finally
        {
          bots.forEach(bot => bot.close());
          await Promise.all(rooms.map(room => room.leave()));
        }
      });
    }
  }
  finally
  {
    await server.gracefullyShutdown(false);
  }
});
