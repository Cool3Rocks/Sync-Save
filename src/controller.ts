export type Settings = { source: string; enabled: boolean };
export type RecordInfo = { appid?: number; state?: 'checking' | 'waiting' | 'disabled' | 'missing'; changed?: boolean; prefix?: string; target?: string; backup?: string | null; error?: string };
export type Snapshot = { settings: Settings; last: RecordInfo | null; warning: string | null };
export type Reply<T> = { ok: true; data: T } | { ok: false; error: string };
export type LaunchResult = { action: 'ignored' | 'disabled' | 'waiting' | 'missing' | 'linked' | 'unchanged'; record?: RecordInfo | null };
export interface Backend {
  read(): Promise<Reply<Snapshot>>;
  save(settings: Settings): Promise<Reply<Snapshot>>;
  launch(appid: number, attempt?: number): Promise<Reply<LaunchResult>>;
}
export type View = {
  loaded: boolean; busy: 'loading' | 'choosing' | 'saving' | null;
  draft: Settings; saved: Settings | null; last: RecordInfo | null;
  message: string; failed: boolean;
};

export function describeError(error: unknown): string {
  if (typeof error === 'string' && error) return error;
  if (error && typeof error === 'object') {
    const value = error as { message?: unknown; error?: unknown };
    if (value.message) return describeError(value.message);
    if (value.error) return describeError(value.error);
  }
  return '后端未返回错误详情，请检查 Decky 插件日志';
}

export async function deadline<T>(task: Promise<T>, milliseconds = 15000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([task, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('后端未及时响应；保存结果可能尚未确认，请刷新状态后核对')), milliseconds);
    })]);
  } finally { if (timer !== undefined) clearTimeout(timer); }
}

export function unwrap<T>(reply: Reply<T>): T {
  if (!reply || typeof reply.ok !== 'boolean') throw new Error('前后端响应格式不匹配，请重新加载 Sync Save 0.2.4');
  if (!reply.ok) throw new Error(reply.error || '操作失败，未返回原因');
  return reply.data;
}

function checkedSnapshot(reply: Reply<Snapshot>): Snapshot {
  const value = unwrap(reply);
  if (!value || typeof value.settings?.source !== 'string' || typeof value.settings?.enabled !== 'boolean') {
    throw new Error('后端返回了无效设置，无法确认保存结果');
  }
  return value;
}

export class SettingsController {
  private listeners = new Set<() => void>();
  private alive = true;
  private recordVersion = 0;
  private view: View = {
    loaded: false, busy: null, draft: { source: '', enabled: false }, saved: null,
    last: null, message: '正在加载设置…', failed: false,
  };
  constructor(private backend: Backend,
    private pick: (start: string) => Promise<{ path: string; realpath?: string }>,
    private notify: (message: string) => void, private timeout = 15000) {}

  snapshot = (): View => this.view;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  private commit(update: Partial<View>) {
    if (!this.alive) return;
    this.view = { ...this.view, ...update };
    for (const listener of this.listeners) listener();
  }
  private announce(message: string) {
    if (!this.alive) return;
    try { this.notify(message); } catch { /* The panel still shows the message. */ }
  }
  private fail(error: unknown) {
    const message = describeError(error);
    this.commit({ failed: true, message });
    this.announce(message);
  }
  updateRecord(record: RecordInfo) { this.recordVersion++; this.commit({ last: record }); }
  async refresh() {
    if (this.view.busy || !this.alive) return;
    const recordVersion = this.recordVersion;
    this.commit({ busy: 'loading', message: '正在读取已保存的设置…', failed: false });
    try {
      const data = checkedSnapshot(await deadline(this.backend.read(), this.timeout));
      this.commit({ loaded: true, saved: data.settings, last: recordVersion === this.recordVersion ? data.last : this.view.last,
        draft: this.view.loaded ? this.view.draft : { ...data.settings },
        message: data.warning || '已读取保存的设置', failed: Boolean(data.warning) });
    } catch (error) { this.fail(error); }
    finally { this.commit({ busy: null }); }
  }
  setEnabled(enabled: boolean) {
    if (!this.view.loaded || this.view.busy) return;
    this.commit({ draft: { ...this.view.draft, enabled }, message: '设置尚未保存', failed: false });
  }
  async choose() {
    if (!this.view.loaded || this.view.busy || !this.alive) return;
    this.commit({ busy: 'choosing', failed: false });
    try {
      const selected = await this.pick(this.view.draft.source || '/home/deck');
      const source = selected.realpath || selected.path;
      if (!source || !source.startsWith('/')) throw new Error('目录选择器未返回 Steam Deck 本地绝对路径');
      this.commit({ draft: { ...this.view.draft, source }, message: '已选择目录，点击保存设置后生效' });
    } catch (error) {
      if (describeError(error) !== 'User canceled') this.fail(error);
    } finally { this.commit({ busy: null }); }
  }
  async save() {
    if (!this.view.loaded || this.view.busy || !this.alive) return;
    const submitted = { ...this.view.draft };
    const recordVersion = this.recordVersion;
    this.commit({ busy: 'saving', message: '正在写入并确认设置…', failed: false });
    try {
      const data = checkedSnapshot(await deadline(this.backend.save(submitted), this.timeout));
      if (data.settings.enabled !== submitted.enabled) throw new Error('自动连接开关保存结果不一致，请刷新核对');
      const message = `设置已保存，自动连接已${data.settings.enabled ? '开启' : '关闭'}`;
      this.commit({ draft: { ...data.settings }, saved: data.settings,
        last: recordVersion === this.recordVersion ? data.last : this.view.last, message, failed: false });
      this.announce(message);
    } catch (error) { this.fail(error); }
    finally { this.commit({ busy: null }); }
  }
  dispose() { this.alive = false; this.listeners.clear(); }
}

export function recordText(record: RecordInfo | null): string {
  if (!record || !Object.keys(record).length) return '暂无连接记录';
  if (record.error) return `连接错误：${record.error}`;
  return [record.appid ? `游戏：${record.appid}` : '',
    connectionSummary(record),
    record.prefix ? `Proton：${record.prefix}` : '',
    record.target ? `用户目录：${record.target}` : '',
    record.backup ? `原目录备份：${record.backup}` : ''].filter(Boolean).join('\n');
}

export function connectionSummary(record: RecordInfo): string {
  switch (record.state) {
    case 'checking': return '正在检查游戏目录…';
    case 'waiting': return '等待 Proton 用户目录初始化…';
    case 'disabled': return '自动连接已关闭，本次启动未连接';
    case 'missing': return '未检测到 Proton 用户目录，本次启动未连接';
    default: return record.changed ? '已建立目录链接' : '目录链接已正确存在';
  }
}
