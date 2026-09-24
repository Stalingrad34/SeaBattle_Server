import { ArraySchema, MapSchema, Schema, type, view } from "@colyseus/schema";

export class CellState extends Schema {
  @type("int32") x = 0;
  @type("int32") y = 0;
}

export class ShipState extends Schema {
  @type("string") id = "";
  @type([CellState]) cells = new ArraySchema<CellState>();
}

export class ShotState extends Schema {
  @type("int32") x = 0;
  @type("int32") y = 0;
  @type("string") result = "";
  @type([CellState]) sunkCells = new ArraySchema<CellState>();
}

export class PlayerState extends Schema {
  @type("string") playerId = "";
  @type([ShipState]) ownShips = new ArraySchema<ShipState>();
  @type([ShotState]) incomingShots = new ArraySchema<ShotState>();
  @type([ShotState]) outgoingShots = new ArraySchema<ShotState>();
}

export class MatchState extends Schema {
  @type("string") matchId = "";
  @type("string") phase = "waiting";
  @type("string") activePlayerId = "";
  @type("string") winnerId = "";
  @type("int64") revision = 0;
  @type("int64") turnId = 0;
  @type("float64") deadlineMs = 0;
  @type("int32") boardSize = 6;
  @type("int32") turnDurationSeconds = 15;
  @type(["int32"]) shipLengths = new ArraySchema<number>(3, 2, 2, 1);
  @type("int32") playerCount = 0;

  // Each client sees only its own entry, including the initial state and later patches.
  @view() @type({ map: PlayerState }) players = new MapSchema<PlayerState>();
}
