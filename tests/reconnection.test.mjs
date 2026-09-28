import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { Server } from "@colyseus/core";
import { WebSocketTransport } from "@colyseus/ws-transport";
import { Client } from "colyseus.js";
import { BattleRoom } from "../dist/rooms/BattleRoom.js";

class TestRoom extends BattleRoom
{
  onCreate(options)
  {
    super.onCreate(options);
    // Exercise expiry without waiting for the production 120-second grace period.
    this.reconnectSeconds = 1;
  }
}

test("reconnect restores identity, private fleet, lost command result; expiry forfeits", { timeout: 15000 }, async () =>
{
  const http = createServer();
  const server = new Server({ transport: new WebSocketTransport({ server: http }), greet: false });
  server.define("battle", TestRoom);
  await server.listen(0, "127.0.0.1");
  const client = new Client(`ws://127.0.0.1:${http.address().port}`);
  const rooms = new Set();
  try
  {
    let first = await client.create("battle", { roomName: "RECOV001" });
    rooms.add(first);
    let second = await client.joinById(first.roomId);
    rooms.add(second);
    await Promise.all([first, second].map(room => waitForState(room, state => state.phase === "playing")));
    if (first.sessionId !== first.state.activePlayerId)
    {
      const result = await send(second, { commandId: "opening", turnId: second.state.turnId, x: 0, y: 0 });
      await waitForState(first, state => state.revision >= result.revision);
    }
    const id = first.sessionId;
    const fleet = first.state.players.get(id).ownShips.toJSON();
    // Sink the single-cell ship, including nested private sunkCells in the restored snapshot.
    const cell = second.state.players.get(second.sessionId).ownShips.find(ship => ship.cells.length === 1).cells[0];
    const command = { commandId: "lost-reply", turnId: first.state.turnId, x: cell.x, y: cell.y };
    first.onMessage("commandResult", () => {});
    first.send("fire", command);
    await waitForState(first, state => state.players.get(id).outgoingShots.length === 1);
    const revision = first.state.revision;
    const token = first.reconnectionToken;
    await first.leave(false);
    rooms.delete(first);
    first = await reconnect(client, token);
    rooms.add(first);
    await waitForState(first, state => state.players?.has(id));
    assert.equal(first.sessionId, id);
    assert.equal(first.state.players.size, 1);
    assert.deepEqual(first.state.players.get(id).ownShips.toJSON(), fleet);
    assert.equal(first.state.players.get(id).outgoingShots[0].sunkCells.length, 1);
    assert.equal(first.state.revision, revision);
    const result = await send(first, command);
    assert.equal(result.status, "applied");
    assert.equal(result.revision, revision);
    assert.equal(first.state.players.get(id).outgoingShots.length, 1);
    assert.deepEqual(await send(first, command), result);
    const otherId = second.sessionId;
    const tokens = [first.reconnectionToken, second.reconnectionToken];
    await Promise.all([first.leave(false), second.leave(false)]);
    rooms.delete(first);
    rooms.delete(second);
    [first, second] = await Promise.all(tokens.map(token => reconnect(client, token)));
    rooms.add(first);
    rooms.add(second);
    await Promise.all([first, second].map(room => waitForState(room, state => state.phase === "playing")));
    assert.equal(first.sessionId, id);
    assert.equal(second.sessionId, otherId);
    assert.equal(first.state.players.size, 1);
    assert.equal(second.state.players.size, 1);
    assert.equal(first.state.revision, revision);
    assert.deepEqual(await send(first, command), result, "both clients leaving must not erase command history");
    const expiredToken = first.reconnectionToken;
    await first.leave(false);
    rooms.delete(first);
    await waitForState(second, state => state.phase === "finished");
    assert.equal(second.state.winnerId, second.sessionId);
    await assert.rejects(client.reconnect(expiredToken));
  }
  finally
  {
    await Promise.all([...rooms].map(room => room.leave()));
    await server.gracefullyShutdown(false);
  }
});

async function reconnect(client, token)
{
  for (let attempt = 0; ; attempt++)
  {
    try
    {
      return await client.reconnect(token);
    }
    catch (error)
    {
      if (attempt >= 5) throw error;
      await new Promise(resolve => setTimeout(resolve, 30));
    }
  }
}

function waitForState(room, predicate)
{
  if (predicate(room.state)) return Promise.resolve();
  return new Promise((resolve, reject) =>
  {
    const timer = setTimeout(() => reject(new Error("State timeout")), 3000);
    room.onStateChange(state =>
    {
      if (predicate(state))
      {
        clearTimeout(timer);
        resolve();
      }
    });
  });
}

function send(room, command)
{
  return new Promise((resolve, reject) =>
  {
    const timer = setTimeout(() => reject(new Error("Result timeout")), 3000);
    room.onMessage("commandResult", result =>
    {
      if (result.commandId === command.commandId)
      {
        clearTimeout(timer);
        resolve(result);
      }
    });
    room.send("fire", command);
  });
}
