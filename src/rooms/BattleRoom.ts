import { Client, Room, ServerError } from "@colyseus/core";
import { StateView } from "@colyseus/schema";
import { GameConfig, loadGameConfig, validateGameConfig } from "../config/GameConfig.js";
import { BattleGame } from "../game/BattleGame.js";
import { FireCommand } from "../protocol/messages.js";
import { MatchState } from "./schema/MatchState.js";

export class BattleRoom extends Room<MatchState>
{
  maxClients = 2;
  private game!: BattleGame;
  private static readonly names = new Set<string>();
  private reservedName?: string;
  private reconnectSeconds = 120;

  onCreate(options: { roomName?: string; gameConfig?: Pick<GameConfig, "BoardSize" | "ShipLengths" | "TurnDurationSeconds"> }): void
  {
    const name = options.roomName;
    if (typeof name !== "string" || !/^[A-Za-z0-9]{8}$/.test(name))
    {
      throw new ServerError(400, "invalid_room_name");
    }
    if (BattleRoom.names.has(name))
    {
      throw new ServerError(409, "room_name_taken");
    }
    this.roomId = name;
    let config = loadGameConfig();
    if (options.gameConfig !== undefined)
    {
      try
      {
        config = validateGameConfig({
          ...config,
          BoardSize: options.gameConfig?.BoardSize,
          ShipLengths: options.gameConfig?.ShipLengths,
          TurnDurationSeconds: options.gameConfig?.TurnDurationSeconds
        });
      }
      catch
      {
        throw new ServerError(400, "invalid_game_config");
      }
    }
    this.reconnectSeconds = config.ReconnectGraceSeconds;
    this.game = new BattleGame(config, this.roomId, () => performance.now());
    BattleRoom.names.add(name);
    this.reservedName = name;
    this.state = this.game.state;
    this.onMessage("serverTime", (client, requestId: number) =>
    {
      if (Number.isSafeInteger(requestId))
      {
        client.send("serverTime", { requestId, serverTimeMs: performance.now() });
      }
    });
    this.onMessage("fire", (client, command: FireCommand) =>
    {
      if (!command || typeof command.commandId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(command.commandId) ||
          !Number.isSafeInteger(command.turnId) || command.turnId < 1 ||
          typeof command.x !== "number" || typeof command.y !== "number")
      {
        client.send("error", "invalid_request");
        return;
      }
      const result = this.game.fire(client.sessionId, command);
      if (result.status === "applied")
      {
        // Nested arrays added after joining must be included in each owner's StateView.
        for (const connection of this.clients)
        {
          const player = this.state.players.get(connection.sessionId)!;
          const shots = connection === client ? player.outgoingShots : player.incomingShots;
          const shot = shots[shots.length - 1];
          if (shot?.result === "sunk")
          {
            connection.view!.add(shot);
          }
        }
      }
      client.send("commandResult", result);
    });
    this.clock.setInterval(() => this.game.tick(), 100);
  }

  async onJoin(client: Client): Promise<void>
  {
    const player = this.game.addPlayer(client.sessionId);
    client.view = new StateView();
    client.view.add(player);
    if (this.state.phase === "playing")
    {
      await this.lock();
    }
  }

  async onLeave(client: Client, consented: boolean): Promise<void>
  {
    if (!consented && this.state.players.has(client.sessionId))
    {
      try
      {
        const restored = await this.allowReconnection(client, this.reconnectSeconds);
        restored.view = new StateView();
        restored.view.add(this.state.players.get(restored.sessionId)!);
        return;
      }
      catch
      {
        // Reservation expired: waiting players free their seat; active players forfeit.
      }
    }
    this.game.removePlayer(client.sessionId);
  }

  onDispose(): void
  {
    if (this.reservedName)
    {
      BattleRoom.names.delete(this.reservedName);
    }
  }
}
