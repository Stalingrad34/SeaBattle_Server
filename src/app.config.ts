import config from "@colyseus/tools";
import { BattleRoom } from "./rooms/BattleRoom.js";
import { loadGameConfig } from "./config/GameConfig.js";

export default config({
  initializeGameServer: (server) =>
  {
    server.define("battle", BattleRoom);
  },
  beforeListen: () =>
  {
    loadGameConfig();
  },
});
