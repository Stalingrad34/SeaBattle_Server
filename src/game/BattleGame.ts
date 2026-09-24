import { ArraySchema } from "@colyseus/schema";
import { GameConfig, validateGameConfig } from "../config/GameConfig.js";
import { CommandResult, FireCommand } from "../protocol/messages.js";
import { CellState, MatchState, PlayerState, ShotState } from "../rooms/schema/MatchState.js";
import { placeFleet } from "./FleetPlacement.js";

export class BattleGame
{
  readonly state = new MatchState();
  private readonly accepted = new Map<string, Map<string, { command: FireCommand; result: CommandResult }>>();
  private readonly config: GameConfig;

  constructor(config: GameConfig, matchId: string, private readonly now: () => number, private readonly random: () => number = Math.random)
  {
    this.config = validateGameConfig(config);
    this.state.matchId = matchId;
    this.state.boardSize = config.BoardSize;
    this.state.turnDurationSeconds = config.TurnDurationSeconds;
    this.state.shipLengths = new ArraySchema<number>(...config.ShipLengths);
  }

  addPlayer(id: string): PlayerState
  {
    if (this.state.phase !== "waiting" || this.state.players.size >= 2 || this.state.players.has(id))
    {
      throw new Error("Match is not accepting players.");
    }
    const player = new PlayerState();
    player.playerId = id;
    player.ownShips = new ArraySchema(...placeFleet(this.config.BoardSize, this.config.ShipLengths, this.random));
    this.state.players.set(id, player);
    this.accepted.set(id, new Map());
    this.state.playerCount = this.state.players.size;
    if (this.state.playerCount === 2)
    {
      this.state.phase = "playing";
      this.state.activePlayerId = [...this.state.players.keys()][Math.floor(this.random() * 2)];
      this.state.turnId = 1;
      this.state.deadlineMs = this.now() + this.config.TurnDurationSeconds * 1000;
    }
    this.state.revision++;
    return player;
  }

  removePlayer(id: string): void
  {
    if (!this.state.players.has(id))
    {
      return;
    }
    if (this.state.phase === "waiting")
    {
      this.state.players.delete(id);
      this.accepted.delete(id);
      this.state.playerCount = this.state.players.size;
      this.state.revision++;
    }
    else if (this.state.phase === "playing")
    {
      this.finish(this.opponentId(id));
      this.state.revision++;
    }
  }

  tick(): boolean
  {
    if (this.state.phase !== "playing" || this.now() < this.state.deadlineMs)
    {
      return false;
    }
    this.nextTurn();
    this.state.revision++;
    return true;
  }

  fire(playerId: string, command: FireCommand): CommandResult
  {
    const previous = this.accepted.get(playerId)?.get(command.commandId);
    if (previous)
    {
      if (previous.command.turnId !== command.turnId || previous.command.x !== command.x || previous.command.y !== command.y)
      {
        return this.rejected(command, "command_conflict");
      }
      return { ...previous.result };
    }
    const expiredTurn = this.state.turnId;
    const expired = this.tick();
    if (!this.state.players.has(playerId))
    {
      return this.rejected(command, "unauthorized");
    }
    if (this.state.phase !== "playing")
    {
      return this.rejected(command, this.state.phase === "finished" ? "match_finished" : "match_not_started");
    }
    if (!Number.isSafeInteger(command.turnId) || command.turnId !== this.state.turnId)
    {
      return this.rejected(command, expired && command.turnId === expiredTurn ? "turn_expired" : "wrong_turn");
    }
    if (playerId !== this.state.activePlayerId)
    {
      return this.rejected(command, "wrong_turn");
    }
    if (!Number.isInteger(command.x) || !Number.isInteger(command.y) || command.x < 0 || command.y < 0 ||
        command.x >= this.state.boardSize || command.y >= this.state.boardSize)
    {
      return this.rejected(command, "out_of_bounds");
    }
    const attacker = this.state.players.get(playerId)!;
    const defender = this.state.players.get(this.opponentId(playerId))!;
    if (attacker.outgoingShots.some(shot => shot.x === command.x && shot.y === command.y))
    {
      return this.rejected(command, "already_shot");
    }
    const ship = defender.ownShips.find(ship => ship.cells.some(cell => cell.x === command.x && cell.y === command.y));
    const sunk = ship && ship.cells.every(cell => cell.x === command.x && cell.y === command.y ||
      attacker.outgoingShots.some(shot => shot.x === cell.x && shot.y === cell.y));
    const result = ship ? (sunk ? "sunk" : "hit") : "miss";
    // Independent Schema instances: each private view owns its entire subtree.
    for (const shots of [attacker.outgoingShots, defender.incomingShots])
    {
      const shot = new ShotState().assign({ x: command.x, y: command.y, result });
      if (sunk)
      {
        shot.sunkCells = new ArraySchema(...ship!.cells.map(cell => new CellState().assign({ x: cell.x, y: cell.y })));
      }
      shots.push(shot);
    }
    const defeated = defender.ownShips.every(ship => ship.cells.every(cell =>
      attacker.outgoingShots.some(shot => shot.x === cell.x && shot.y === cell.y)));
    if (defeated)
    {
      this.finish(playerId);
    }
    else
    {
      this.nextTurn();
    }
    this.state.revision++;
    const response: CommandResult = { commandId: command.commandId, turnId: command.turnId,
      revision: this.state.revision, status: "applied", reason: null };
    this.accepted.get(playerId)!.set(command.commandId, { command: { ...command }, result: response });
    return { ...response };
  }

  private rejected(command: FireCommand, reason: string): CommandResult
  {
    return { commandId: command.commandId, turnId: command.turnId, revision: this.state.revision, status: "rejected", reason };
  }

  private opponentId(id: string): string
  {
    return [...this.state.players.keys()].find(key => key !== id)!;
  }

  private nextTurn(): void
  {
    this.state.activePlayerId = this.opponentId(this.state.activePlayerId);
    this.state.turnId++;
    this.state.deadlineMs = this.now() + this.config.TurnDurationSeconds * 1000;
  }

  private finish(winnerId: string): void
  {
    this.state.phase = "finished";
    this.state.winnerId = winnerId;
    this.state.activePlayerId = "";
    this.state.deadlineMs = 0;
  }
}
