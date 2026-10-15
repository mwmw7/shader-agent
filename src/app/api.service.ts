import { Injectable } from '@angular/core';
import type { PublicProvider, ModelInfo, Verification, RunState, AGENTS } from '../../shared/contracts';
import type { TeamProfile } from '../../shared/team-contracts';
import type { ExperimentState } from '../../shared/experiment-contracts';

export interface Bootstrap { providers: PublicProvider[]; agents: typeof AGENTS; defaultGlsl: string; }

@Injectable({ providedIn: 'root' })
export class ApiService {
  async request<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
    const response = await fetch(`/api${path}`, {
      method,
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const data = await response.json().catch(() => null);
    if (!response.ok) throw new Error(data?.error?.message || data?.error || data?.message || `요청 실패 (${response.status})`);
    return data as T;
  }
  bootstrap() { return this.request<Bootstrap>('/bootstrap'); }
  providers() { return this.request<PublicProvider[]>('/providers'); }
  saveProvider(body: unknown) { return this.request<PublicProvider>('/providers', 'POST', body); }
  deleteProvider(id: string) { return this.request(`/providers/${encodeURIComponent(id)}`, 'DELETE'); }
  models(id: string) { return this.request<ModelInfo[]>(`/providers/${encodeURIComponent(id)}/models`, 'POST', {}); }
  verify(id: string, model: string) { return this.request<Verification>(`/providers/${encodeURIComponent(id)}/verify`, 'POST', { model }); }
  runs() { return this.request<RunState[]>('/runs'); }
  run(id: string) { return this.request<RunState>(`/runs/${encodeURIComponent(id)}`); }
  cancel(id: string) { return this.request(`/runs/${encodeURIComponent(id)}/cancel`, 'POST', {}); }
  teams() { return this.request<TeamProfile[]>('/teams'); }
  saveTeam(team: Partial<TeamProfile>) { return this.request<TeamProfile>('/teams', 'POST', team); }
  deleteTeam(id: string) { return this.request(`/teams/${encodeURIComponent(id)}`, 'DELETE'); }
  experiments() { return this.request<ExperimentState[]>('/experiments'); }
  experiment(id: string) { return this.request<ExperimentState>(`/experiments/${encodeURIComponent(id)}`); }
  startExperiment(input: unknown) { return this.request<{ id: string }>('/experiments', 'POST', input); }
  cancelExperiment(id: string) { return this.request(`/experiments/${encodeURIComponent(id)}/cancel`, 'POST', {}); }
}
