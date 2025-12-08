import { VoiceChatEnv } from "./config";

export type Vector3 = {
  x: number;
  y: number;
  z: number;
};

export type DurableObjectStub = {
  fetch(input: Request | string, init?: RequestInit): Promise<Response>;
};

export type DurableObjectNamespace = {
  idFromName(name: string): unknown;
  get(id: unknown): DurableObjectStub;
};

export interface VoiceWorkerEnv extends VoiceChatEnv {
  WORLD_SHARD: DurableObjectNamespace;
}
