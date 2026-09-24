import { Client, Room } from "@colyseus/core";
import { StateView } from "@colyseus/schema";
import { loadGameConfig } from "../config/GameConfig.js";
import { BattleGame } from "../game/BattleGame.js";
import { FireCommand } from "../protocol/messages.js";
import { MatchState } from "./schema/MatchState.js";

export class BattleRoom extends Room<MatchState>
{
  maxClients = 2;
  private game!: BattleGame;

  onCreate(): void
  {
    this.game = new BattleGame(loadGameConfig(), this.roomId, () => performance.now());
    this.state = this.game.state;
    this.onMessage("fire", (client, command: FireCommand) =>
    {
      if (!command || typeof command.commandId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(command.commandId) ||
          !Number.isSafeInteger(command.turnId) || command.turnId < 1 ||
          typeof command.x !== "number" || typeof command.y !== "number")
      {
        client.send("error", "invalid_request");
        return;
      }
      client.send("commandResult", this.game.fire(client.sessionId, command));
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

  onLeave(client: Client): void
  {
    this.game.removePlayer(client.sessionId);
  }
}
