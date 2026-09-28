import { CellState, ShipState } from "../rooms/schema/MatchState.js";

/** Straight ships cannot touch, even diagonally. Longest ships are placed first. */
export function placeFleet(size: number, lengths: readonly number[], random: () => number): ShipState[]
{
  const order = lengths.map((length, index) => ({ length, index })).sort((a, b) => b.length - a.length);
  const occupied = new Set<number>();
  const ships: ShipState[] = [];
  let attempts = 0;

  function place(index: number): boolean
  {
    if (index === order.length)
    {
      return true;
    }
    const { length, index: shipIndex } = order[index];
    const candidates: number[][] = [];
    for (let y = 0; y < size; y++)
    {
      for (let x = 0; x < size; x++)
      {
        for (const vertical of [false, true])
        {
          if (vertical && length === 1 || x + (vertical ? 1 : length) > size || y + (vertical ? length : 1) > size)
          {
            continue;
          }
          const cells = Array.from({ length }, (_, step) => (y + (vertical ? step : 0)) * size + x + (vertical ? 0 : step));
          if (cells.every(cell =>
          {
            const cx = cell % size;
            const cy = Math.floor(cell / size);
            for (let ny = Math.max(0, cy - 1); ny <= Math.min(size - 1, cy + 1); ny++)
            {
              for (let nx = Math.max(0, cx - 1); nx <= Math.min(size - 1, cx + 1); nx++)
              {
                if (occupied.has(ny * size + nx))
                {
                  return false;
                }
              }
            }
            return true;
          }))
          {
            candidates.push(cells);
          }
        }
      }
    }
    for (let i = candidates.length - 1; i > 0; i--)
    {
      const j = Math.floor(random() * (i + 1));
      [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
    }
    for (const cells of candidates)
    {
      if (++attempts > 100000)
      {
        throw new Error("Fleet placement search limit exceeded; reduce the configured fleet.");
      }
      cells.forEach(cell => occupied.add(cell));
      const ship = new ShipState();
      ship.id = `ship-${shipIndex}`;
      for (const cell of cells)
      {
        ship.cells.push(new CellState().assign({ x: cell % size, y: Math.floor(cell / size) }));
      }
      ships.push(ship);
      if (place(index + 1))
      {
        return true;
      }
      ships.pop();
      cells.forEach(cell => occupied.delete(cell));
    }
    return false;
  }

  if (!place(0))
  {
    throw new Error("Configured fleet cannot be placed on the board.");
  }
  return ships;
}
