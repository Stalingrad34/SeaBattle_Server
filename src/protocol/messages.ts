export interface FireCommand
{
  commandId: string;
  turnId: number;
  x: number;
  y: number;
}

export interface CommandResult
{
  commandId: string;
  turnId: number;
  revision: number;
  status: "applied" | "rejected";
  reason: string | null;
}
