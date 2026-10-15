import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { DEFAULT_TEAMS, type TeamNode, type TeamProfile } from '../shared/team-contracts.js';
import { parseTeamProfile } from './team-policy.js';

const clone = <T>(value: T): T => structuredClone(value);

/** Three experimental starting points, repeated across ten independently editable teams. */
function initialTeams(): TeamProfile[] {
  const base = DEFAULT_TEAMS[0]!;
  const specialist = DEFAULT_TEAMS[1]!;
  const hypotheses = [
    '핵심 역할만 연결한 구성이 공통 요청을 충족하는지, 추가 전문 역할과 비교합니다.',
    '제작 전에 구도·색상·움직임 계획을 분리하면 시각적 요구 충족도가 개선되는지 검증합니다.',
    '실제 영상 프레임을 별도 검토한 의견이 수정의 정확도를 개선하는지 검증합니다.',
  ];
  return Array.from({ length: 10 }, (_, index) => {
    const preset = index % 3;
    const nodes: TeamNode[] = [];
    for (const source of base.nodes.filter(item => item.role !== 'search')) {
      nodes.push(clone(source));
      if (source.role === 'analyze' && preset === 1) {
        const plans = specialist.nodes.filter(item => item.role === 'plan');
        nodes.push(clone(plans[0]!), {
          id: 'color-plan', role: 'plan', name: '색상 설계자', icon: '🎨', enabled: true,
          prompt: '참고 이미지와 요청에서 주요 색, 밝기 대비, 색상 비율을 관찰하고 제작에 필요한 구체적 색상 계획을 제안하세요.',
        }, clone(plans[1]!));
      }
      if (source.role === 'render' && preset === 2) {
        nodes.push(clone(specialist.nodes.find(item => item.role === 'review')!));
      }
    }
    nodes.forEach((node, nodeIndex) => {
      node.id = `node-${nodeIndex + 1}-${node.role}`;
      node.prompt = `목적: ${node.prompt}\n설계 가설: ${hypotheses[preset]}\n가설은 검증 대상입니다. 다른 팀과 다른 결과를 억지로 만들거나 가설을 지지하도록 평가하지 말고, 공통 요청과 실제 증거에 따라 판단하세요.`;
    });
    return parseTeamProfile({
      id: randomUUID(), name: `${String(index + 1).padStart(2, '0')}팀`,
      hypothesis: hypotheses[preset], mode: 'fixed', nodes,
    });
  });
}

/** Team configuration is independent of provider credentials and run artifacts. */
export class TeamStore {
  private entries = new Map<string, TeamProfile>();
  private pending: Promise<void> = Promise.resolve();
  private initialized = false;
  constructor(readonly directory: string) {}

  async init(): Promise<void> {
    return this.enqueue(async () => {
      if (this.initialized) return;
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      let stored: string;
      try {
        stored = await readFile(path.join(this.directory, 'teams.json'), 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        const defaults = initialTeams();
        await this.write(defaults);
        this.entries = new Map(defaults.map(profile => [profile.id, profile]));
        this.initialized = true;
        return;
      }
      try {
        const raw: unknown = JSON.parse(stored);
        if (!raw || typeof raw !== 'object' || !('version' in raw) || raw.version !== 1 ||
            !('teams' in raw) || !Array.isArray(raw.teams)) throw new Error('잘못된 팀 설정 형식입니다.');
        const profiles = raw.teams.map(item => parseTeamProfile(item));
        if (new Set(profiles.map(profile => profile.id)).size !== profiles.length) throw new Error('중복된 팀 ID입니다.');
        this.entries = new Map(profiles.map(profile => [profile.id, profile]));
        this.initialized = true;
      } catch (error) {
        throw new Error('teams.json을 읽을 수 없습니다. 기존 팀 설정 파일을 확인하세요.', { cause: error });
      }
    });
  }

  list(): TeamProfile[] { this.assertInitialized(); return [...this.entries.values()].map(clone); }
  get(id: string): TeamProfile | undefined {
    this.assertInitialized();
    const profile = this.entries.get(id);
    return profile ? clone(profile) : undefined;
  }
  async put(value: TeamProfile): Promise<TeamProfile> {
    // Validate and detach caller-owned objects before queuing the transaction.
    const profile = clone(parseTeamProfile(value));
    return this.enqueue(async () => {
      this.assertInitialized();
      const next = new Map(this.entries);
      next.set(profile.id, profile);
      await this.write([...next.values()]);
      this.entries = next;
      return clone(profile);
    });
  }
  async remove(id: string): Promise<boolean> {
    return this.enqueue(async () => {
      this.assertInitialized();
      const next = new Map(this.entries);
      if (!next.delete(id)) return false;
      await this.write([...next.values()]);
      this.entries = next;
      return true;
    });
  }

  private assertInitialized(): void {
    if (!this.initialized) throw new Error('TeamStore.init()을 먼저 호출하세요.');
  }
  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.pending.then(operation);
    this.pending = result.then(() => undefined, () => undefined);
    return result;
  }
  private async write(profiles: TeamProfile[]): Promise<void> {
    const target = path.join(this.directory, 'teams.json');
    const temporary = path.join(this.directory, `.teams-${randomUUID()}.tmp`);
    try {
      const file = await open(temporary, 'wx', 0o600);
      try {
        await file.writeFile(JSON.stringify({ version: 1, teams: profiles }, null, 2), 'utf8');
        await file.sync();
      } finally { await file.close(); }
      await rename(temporary, target);
    } finally {
      await rm(temporary, { force: true });
    }
  }
}
