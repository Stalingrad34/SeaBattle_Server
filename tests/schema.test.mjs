import { test } from "node:test";
import assert from "node:assert/strict";
import { Decoder, Encoder, StateView } from "@colyseus/schema";
import { MatchState, PlayerState, ShipState, CellState } from "../dist/rooms/schema/MatchState.js";

test("private ships are filtered in full state and patches, including newly added ships", () => {
  const state = new MatchState();
  const encoder = new Encoder(state);
  const clients = ["a", "b"].map(id => {
    const player = new PlayerState();
    player.playerId = id;
    const ship = new ShipState();
    ship.id = `secret-${id}`;
    ship.cells.push(new CellState().assign({ x: id === "a" ? 1 : 5, y: 2 }));
    player.ownShips.push(ship);
    state.players.set(id, player);
    const view = new StateView();
    view.add(player);
    return { id, view, decoder: new Decoder(new MatchState()) };
  });
  let it = { offset: 0 };
  encoder.encodeAll(it);
  const fullOffset = it.offset;
  for (const client of clients) {
    const bytes = encoder.encodeAllView(client.view, fullOffset, { offset: fullOffset });
    client.decoder.decode(bytes);
    assert.equal(client.decoder.state.players.size, 1);
    assert.equal(client.decoder.state.players.get(client.id).ownShips[0].id, `secret-${client.id}`);
    assert.equal(client.decoder.state.players.has(client.id === "a" ? "b" : "a"), false);
  }
  encoder.discardChanges();
  state.players.get("b").ownShips[0].cells[0].x = 4;
  state.players.get("b").ownShips.push(new ShipState().assign({ id: "new-secret-b" }));
  state.revision++;
  it = { offset: 0 };
  encoder.encode(it);
  const patchOffset = it.offset;
  for (const client of clients) {
    client.decoder.decode(encoder.encodeView(client.view, patchOffset, { offset: patchOffset }));
    assert.equal(client.decoder.state.revision, 1);
    assert.equal(client.decoder.state.players.size, 1);
  }
  assert.equal(clients[0].decoder.state.players.get("a").ownShips.length, 1);
  assert.equal(clients[1].decoder.state.players.get("b").ownShips[0].cells[0].x, 4);
  assert.equal(clients[1].decoder.state.players.get("b").ownShips.length, 2);
});
