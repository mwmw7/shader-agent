import type { RunState } from './contracts.js';
import type { TeamProfile } from './team-contracts.js';

export interface ExperimentInput {
  providerId: string;
  model: string;
  request: string;
  referenceImage: string;
  maxRevisions: number;
}
export interface ExperimentState {
  id: string;
  input: ExperimentInput;
  inputHash: string;
  teamIds: string[];
  teams: TeamProfile[];
  runIds: string[];
  status: 'queued' | 'running' | 'completed' | 'cancelled' | 'interrupted';
  createdAt: string;
  finishedAt?: string;
  imported?: boolean;
}
/** Portable data only. Importing never executes agents or shader code. */
export interface ComparisonPackage {
  format: 'shader-harness-comparison';
  version: 1;
  experiment: ExperimentState;
  runs: RunState[];
  files: Record<string, Record<string, string>>;
}
