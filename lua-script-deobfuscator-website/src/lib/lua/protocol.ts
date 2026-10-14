import { DeobResult, Options } from "./engine";

export interface TransformRequest {
  id: number;
  source: string;
  options: Options;
}

export interface TransformResponse {
  id: number;
  result?: DeobResult;
  error?: string;
  durationMs: number;
}