import { Backend, deadline, describeError, RecordInfo, unwrap } from './controller';

type Session = { active: boolean; controller: AbortController };
export function wait(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    if (signal.aborted) { resolve(); return; }
    const done = () => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); };
    const timer = setTimeout(done, milliseconds);
    signal.addEventListener('abort', done, { once: true });
  });
}

export class GameRunner {
  private sessions = new Map<number, Session>();
  private alive = true;
  constructor(private backend: Backend, private notify: (message: string) => void,
    private terminate: (appid: string) => Promise<void>,
    private sleep = wait, private timeout = 15000,
    private updateRecord: (record: RecordInfo) => void = () => {}) {}

  event(appid: number, running: boolean) {
    if (!this.alive || !Number.isInteger(appid)) return;
    appid = appid >>> 0;
    if (!running) { this.stop(appid); return; }
    if (!(appid & 0x80000000) || this.sessions.has(appid)) return;
    const session = { active: true, controller: new AbortController() };
    this.sessions.set(appid, session);
    this.updateRecord({ appid, state: 'checking' });
    void this.run(appid, session);
  }
  private current(appid: number, session: Session) {
    return this.alive && session.active && this.sessions.get(appid) === session;
  }
  private async run(appid: number, session: Session) {
    try {
      for (let count = 0; count < 45 && this.current(appid, session); count++) {
        const result = unwrap(await deadline(this.backend.launch(appid, count), this.timeout));
        if (!this.current(appid, session)) return;
        if (result.record) this.updateRecord(result.record);
        else if (result.action === 'waiting' || result.action === 'disabled') {
          this.updateRecord({ appid, state: result.action });
        }
        if (result.action === 'missing') {
          this.notify('未找到已初始化的 Proton 用户目录，本次启动未连接。');
          return;
        }
        if (result.action === 'linked') {
          this.notify('目录已连接，5 秒后请求关闭游戏，请重新启动使存档目录生效。');
          await this.sleep(5000, session.controller.signal);
          if (!this.current(appid, session)) return;
          try { await deadline(this.terminate(String(appid)), this.timeout); }
          catch (error) {
            if (this.current(appid, session)) this.notify(`请手动退出并重新启动游戏：${describeError(error)}`);
          }
          return;
        }
        if (result.action !== 'waiting') return;
        if (count < 44) await this.sleep(1000, session.controller.signal);
      }
      if (this.current(appid, session)) {
        this.updateRecord({ appid, state: 'missing' });
        this.notify('未找到已初始化的 Proton 用户目录，本次启动未连接。');
      }
    } catch (error) {
      if (this.current(appid, session)) {
        this.updateRecord({ appid, error: describeError(error) });
        this.notify(describeError(error));
      }
    }
  }
  stop(appid: number) {
    const session = this.sessions.get(appid);
    if (session) { session.active = false; session.controller.abort(); this.sessions.delete(appid); }
  }
  cancelAll() { for (const appid of this.sessions.keys()) this.stop(appid); }
  dispose() { this.alive = false; this.cancelAll(); }
}
