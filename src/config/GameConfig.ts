import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export interface GameConfig
{
  BoardSize: number;
  ShipLengths: number[];
  TurnDurationSeconds: number;
  ReconnectGraceSeconds: number;
}

export function validateGameConfig(value: unknown): GameConfig
{
  const config = value as GameConfig;
  if (!config || !Number.isInteger(config.BoardSize) || config.BoardSize < 2 || config.BoardSize > 32 ||
      !Number.isSafeInteger(config.TurnDurationSeconds) || config.TurnDurationSeconds < 1 ||
      config.TurnDurationSeconds > 86400 || !Number.isSafeInteger(config.ReconnectGraceSeconds) ||
      config.ReconnectGraceSeconds < 1 || !Array.isArray(config.ShipLengths) || config.ShipLengths.length === 0 ||
      config.ShipLengths.some(length => !Number.isInteger(length) || length < 1 || length > config.BoardSize) ||
      config.ShipLengths.reduce((sum, length) => sum + length, 0) > config.BoardSize ** 2)
  {
    throw new Error("Invalid server game configuration.");
  }
  return { ...config, ShipLengths: [...config.ShipLengths] };
}

export function loadGameConfig(): GameConfig
{
  return validateGameConfig(JSON.parse(readFileSync(resolve(__dirname, "../../config/game.json"), "utf8")));
}

