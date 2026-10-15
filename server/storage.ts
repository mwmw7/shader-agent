import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ProviderConfig, PublicProvider, Verification } from '../shared/contracts.js';

type Entry = { config: ProviderConfig; verifications: Verification[] };
export interface SecretCodec { encrypt(value: string): string; decrypt(value: string): string; }

export class ProviderStore {
  private entries = new Map<string, Entry>();
  private pending: Promise<void> = Promise.resolve();
  constructor(readonly directory: string, private codec?: SecretCodec) {}
  async init() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    try {
      const raw = JSON.parse(await readFile(path.join(this.directory, 'providers.json'), 'utf8'));
      for (const item of raw.providers ?? []) {
        const config: ProviderConfig = item.config;
        if (item.encryptedKey && this.codec) {
          try { config.apiKey = this.codec.decrypt(item.encryptedKey); } catch { /* OS keyring unavailable; re-enter key. */ }
        }
        this.entries.set(config.id, { config, verifications: item.verifications ?? [] });
      }
    } catch (error: any) { if (error.code !== 'ENOENT') throw new Error('providers.json을 읽을 수 없습니다. 설정 파일을 확인하세요.', { cause: error }); }
  }
  get(id: string) { return this.entries.get(id)?.config; }
  public(id: string): PublicProvider {
    const entry = this.entries.get(id);
    if (!entry) throw new Error('프로바이더가 없습니다.');
    const { apiKey, ...config } = entry.config;
    return { ...config, hasApiKey: !!apiKey, verifications: entry.verifications };
  }
  list() { return [...this.entries.keys()].map(id => this.public(id)); }
  async put(config: ProviderConfig) {
    const previous = this.entries.get(config.id);
    const next = { ...config, apiKey: config.apiKey === undefined ? previous?.config.apiKey : config.apiKey };
    const unchanged = previous && previous.config.kind === next.kind && previous.config.baseUrl === next.baseUrl && previous.config.apiKey === next.apiKey;
    this.entries.set(config.id, { config: next, verifications: unchanged ? previous.verifications : [] });
    await this.save();
    return this.public(config.id);
  }
  async remove(id: string) { this.entries.delete(id); await this.save(); }
  async verify(id: string, verification: Verification) {
    const entry = this.entries.get(id);
    if (!entry) throw new Error('프로바이더가 없습니다.');
    entry.verifications = [...entry.verifications.filter(v => v.model !== verification.model), verification];
    await this.save();
  }
  private save() {
    const providers = [...this.entries.values()].map(entry => {
      const { apiKey, ...config } = entry.config;
      return { config, verifications: entry.verifications, ...(apiKey && this.codec ? { encryptedKey: this.codec.encrypt(apiKey) } : {}) };
    });
    const content = JSON.stringify({ version: 1, providers }, null, 2);
    this.pending = this.pending.catch(() => {}).then(async () => {
      const target = path.join(this.directory, 'providers.json');
      await writeFile(target + '.tmp', content, { mode: 0o600 });
      await rename(target + '.tmp', target);
    });
    return this.pending;
  }
}
