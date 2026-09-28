import { test } from "node:test";
import assert from "node:assert/strict";
import { BattleGame } from "../dist/game/BattleGame.js";
import { placeFleet } from "../dist/game/FleetPlacement.js";
import { loadGameConfig, validateGameConfig } from "../dist/config/GameConfig.js";

function seeded(seed)
{
  return () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
}
function fixture(config = loadGameConfig())
{
  let time = 1000;
  const game = new BattleGame(config, "match", () => time, seeded(42));
  game.addPlayer("a");
  game.addPlayer("b");
  return { game, advance: () => { time = game.state.deadlineMs; }, setTime: value => { time = value; } };
}
function command(game, x, y, id = `c-${game.state.turnId}`)
{
  return { x, y, commandId: id, turnId: game.state.turnId };
}
function opponent(game, player)
{
  return [...game.state.players.values()].find(p => p.playerId !== player);
}

test("fleet placement: 200 seeds, configured lengths, straight, contiguous, bounded and disjoint", () =>
{
  for (let seed = 0; seed < 200; seed++)
  {
    const fleet = placeFleet(6, [3, 2, 2, 1], seeded(seed));
    assert.deepEqual(fleet.map(ship => ship.cells.length).sort(), [1, 2, 2, 3]);
    const cells = new Set();
    for (let i = 0; i < fleet.length; i++)
    {
      for (let j = i + 1; j < fleet.length; j++)
      {
        for (const a of fleet[i].cells)
        {
          for (const b of fleet[j].cells)
          {
            assert.ok(Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y)) > 1, "ships must not touch");
          }
        }
      }
    }
    for (const ship of fleet)
    {
      assert.ok(ship.cells.every(c => c.x === ship.cells[0].x) || ship.cells.every(c => c.y === ship.cells[0].y));
      ship.cells.forEach((cell, i) =>
      {
        assert.ok(cell.x >= 0 && cell.x < 6 && cell.y >= 0 && cell.y < 6);
        const key = `${cell.x},${cell.y}`;
        assert.ok(!cells.has(key));
        cells.add(key);
        if (i > 0) assert.equal(Math.abs(cell.x - ship.cells[i - 1].x) + Math.abs(cell.y - ship.cells[i - 1].y), 1);
      });
    }
  }
});

test("configuration is validated and copied into authoritative state", () =>
{
  const config = { BoardSize: 4, ShipLengths: [2, 1], TurnDurationSeconds: 3, ReconnectGraceSeconds: 30 };
  const { game } = fixture(config);
  config.ShipLengths[0] = 4;
  assert.equal(game.state.boardSize, 4);
  assert.deepEqual([...game.state.shipLengths], [2, 1]);
  assert.equal(game.state.deadlineMs, 4000);
  for (const invalid of [{ ...config, BoardSize: 1 }, { ...config, ShipLengths: [5] }, { ...config, ShipLengths: [] }, { ...config, TurnDurationSeconds: 0 }, { ...config, ShipLengths: Array(17).fill(1) }])
    assert.throws(() => validateGameConfig(invalid));
});

test("wrong player, out-of-bounds, fractional coordinates do not consume the turn", () =>
{
  const { game } = fixture();
  const active = game.state.activePlayerId;
  const revision = game.state.revision;
  assert.equal(game.fire(opponent(game, active).playerId, command(game, 0, 0)).reason, "wrong_turn");
  for (const [x, y] of [[-1, 0], [6, 0], [0, 6], [0.5, 2], [NaN, 0]])
    assert.equal(game.fire(active, command(game, x, y, `invalid-${x}-${y}`)).reason, "out_of_bounds");
  assert.equal(game.state.revision, revision);
  assert.equal(game.state.turnId, 1);
});

test("hit changes turn; duplicate is idempotent; double click and changed command payload rejected", () =>
{
  const { game } = fixture();
  const player = game.state.activePlayerId;
  const target = opponent(game, player).ownShips.find(ship => ship.cells.length === 3).cells[0];
  const fire = command(game, target.x, target.y);
  const result = game.fire(player, fire);
  assert.equal(result.status, "applied");
  assert.equal(game.state.players.get(player).outgoingShots[0].result, "hit");
  assert.notEqual(game.state.activePlayerId, player);
  assert.deepEqual(game.fire(player, fire), result);
  assert.equal(game.fire(player, { ...fire, commandId: "double-click" }).reason, "wrong_turn");
  assert.equal(game.fire(player, { ...fire, x: (target.x + 1) % 6 }).reason, "command_conflict");
  assert.equal(game.state.players.get(player).outgoingShots.length, 1);
});

test("deadline boundary rejects fire, server tick advances exactly once, late tick grants a full turn", () =>
{
  const { game, advance, setTime } = fixture();
  const player = game.state.activePlayerId;
  const fire = command(game, 0, 0);
  setTime(game.state.deadlineMs - 1);
  assert.equal(game.tick(), false);
  advance();
  assert.equal(game.fire(player, fire).reason, "turn_expired");
  assert.equal(game.state.turnId, 2);
  assert.equal(game.tick(), false);
  setTime(game.state.deadlineMs + 60000);
  assert.equal(game.tick(), true);
  assert.equal(game.state.turnId, 3);
  assert.equal(game.tick(), false);
});

test("miss and repeated cell; sink reveals only that ship; all ships sunk finishes match", () =>
{
  const { game, advance } = fixture();
  const attacker = game.state.activePlayerId;
  const defender = opponent(game, attacker);
  const occupied = new Set([...defender.ownShips].flatMap(ship => [...ship.cells].map(c => `${c.x},${c.y}`)));
  let miss;
  for (let x = 0; x < 6; x++) for (let y = 0; y < 6; y++) if (!occupied.has(`${x},${y}`)) miss = { x, y };
  game.fire(attacker, command(game, miss.x, miss.y));
  assert.equal(game.state.players.get(attacker).outgoingShots[0].result, "miss");
  advance(); game.tick();
  assert.equal(game.fire(attacker, command(game, miss.x, miss.y, "repeated-cell")).reason, "already_shot");
  for (const ship of defender.ownShips)
  {
    for (const [index, cell] of [...ship.cells].entries())
    {
      if (game.state.activePlayerId !== attacker) { advance(); game.tick(); }
      assert.equal(game.fire(attacker, command(game, cell.x, cell.y)).status, "applied");
      const shot = [...game.state.players.get(attacker).outgoingShots].at(-1);
      assert.equal(shot.result, index === ship.cells.length - 1 ? "sunk" : "hit");
      assert.equal(shot.sunkCells.length, index === ship.cells.length - 1 ? ship.cells.length : 0);
    }
  }
  assert.equal(game.state.phase, "finished");
  assert.equal(game.state.winnerId, attacker);
  assert.equal(game.state.deadlineMs, 0);
  assert.equal(game.tick(), false);
  assert.equal(game.fire(attacker, command(game, 1, 1, "after-finish")).reason, "match_finished");
  assert.deepEqual(defender.incomingShots.toJSON(), game.state.players.get(attacker).outgoingShots.toJSON());
});

test("waiting does not expire; departure before start frees seat; departure during play forfeits", () =>
{
  const game = new BattleGame(loadGameConfig(), "m", () => 100000, seeded(1));
  game.addPlayer("a");
  assert.equal(game.tick(), false);
  assert.equal(game.fire("a", { commandId: "early", turnId: 1, x: 0, y: 0 }).reason, "match_not_started");
  game.removePlayer("a");
  assert.equal(game.state.playerCount, 0);
  game.addPlayer("b"); game.addPlayer("c");
  assert.throws(() => game.addPlayer("d"));
  game.removePlayer("b");
  assert.equal(game.state.winnerId, "c");
  assert.equal(game.state.phase, "finished");
});

test("rejected future-turn command remains rejected when its turn arrives", () =>
{
  const { game, advance } = fixture();
  const player = game.state.activePlayerId;
  const fire = { commandId: "future", turnId: 3, x: 0, y: 0 };
  const rejected = game.fire(player, fire);
  assert.equal(rejected.reason, "wrong_turn");
  advance(); game.tick();
  advance(); game.tick();
  assert.equal(game.state.activePlayerId, player);
  assert.equal(game.state.turnId, 3);
  assert.deepEqual(game.fire(player, fire), rejected);
  assert.equal(game.state.players.get(player).outgoingShots.length, 0);
  assert.equal(game.fire(player, { ...fire, commandId: "new" }).status, "applied");
});

