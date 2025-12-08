export type Vector3 = {
  x: number;
  y: number;
  z: number;
};

export type PeerDiffMessage = {
  type: "peers";
  added?: string[];
  removed?: string[];
  peers?: string[];
  distances?: Record<string, number>;
  positions?: Record<string, Vector3>;
  totalPlayers?: number;
};

export type SignalMessage = {
  type: "signal";
  from: string;
  payload: unknown;
};

export type SignalDeliveryFailedMessage = {
  type: "signal-delivery-failed";
  targetId: string;
};

export type RegisteredMessage = {
  type: "registered";
  playerId: string;
};

export type ErrorMessage = {
  type: "error";
  message: string;
};

export type CellServerMessage =
  | RegisteredMessage
  | SignalDeliveryFailedMessage
  | ErrorMessage
  | SignalMessage
  | PeerDiffMessage;
