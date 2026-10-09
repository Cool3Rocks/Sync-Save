import { CSSProperties, ReactNode, useSyncExternalStore } from 'react';
import { callable, definePlugin, FileSelectionType, openFilePicker, toaster } from '@decky/api';
import { ConfirmModal, DialogButton, Focusable, PanelSection, PanelSectionRow, showModal, ToggleField } from '@decky/ui';
import { Backend, connectionSummary, describeError, LaunchResult, RecordInfo, Reply, Settings, SettingsController, Snapshot } from './controller';
import { GameRunner } from './games';

const backend: Backend = {
  read: callable<[], Reply<Snapshot>>('get_state'),
  save: callable<[Settings], Reply<Snapshot>>('update_settings'),
  launch: callable<[number, number?], Reply<LaunchResult>>('process_launch'),
};
const notify = (body: string) => {
  try { toaster.toast({ title: 'Sync Save', body, showToast: true }); }
  catch (error) { console.warn('Sync Save notification failed', error); }
};

const fullWidth = { width: '100%', minWidth: 0, boxSizing: 'border-box' as const, margin: 0 };
const stack: CSSProperties = { ...fullWidth, display: 'flex', flexDirection: 'column', gap: 3 };
const caption: CSSProperties = { fontSize: 12, lineHeight: '18px', color: '#b8c5d3', padding: '0 12px' };
const buttonStyle: CSSProperties = {
  ...fullWidth, height: 44, minHeight: 44, maxHeight: 44,
  padding: '0 12px', borderRadius: 6, fontSize: 14, fontWeight: 400,
  fontFamily: 'inherit', lineHeight: '20px', display: 'flex', alignItems: 'center',
  justifyContent: 'center', whiteSpace: 'nowrap',
};

function ControlButton({ children, disabled, onClick, path = false }: {
  children: ReactNode; disabled?: boolean; onClick(): void; path?: boolean;
}) {
  return <DialogButton disabled={disabled} onClick={onClick}
    style={{ ...buttonStyle, justifyContent: path ? 'flex-start' : 'center', textAlign: path ? 'left' : 'center' }}>
    {children}
  </DialogButton>;
}

function PathLine({ label, path }: { label: string; path: string }) {
  // Preserve the folder name in the compact view; the dialog shows the exact path.
  const compact = path.length > 48 ? `${path.slice(0, 20)}…${path.slice(-25)}` : path;
  return <div style={stack}>
    <div style={caption}>{label}</div>
    <ControlButton path
      onClick={() => showModal(<ConfirmModal strTitle={label} bAlertDialog strOKButtonText="关闭"
        strDescription={<div style={{ maxHeight: '50vh', overflowY: 'auto', overflowWrap: 'anywhere', whiteSpace: 'pre-wrap' }}>{path}</div>} />)}>
      <span title={path} style={{ display: 'block', minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{compact}</span>
    </ControlButton>
  </div>;
}

function ConnectionStatus({ record }: { record: RecordInfo | null }) {
  const empty = !record || !Object.keys(record).length;
  return <div style={{ ...stack, padding: '8px 0', borderRadius: 6, background: 'rgba(255,255,255,0.04)' }}>
    <div style={caption}>最近连接</div>
    {empty ? <div style={{ padding: '0 12px' }}>暂无连接记录</div> : record.error ?
      <div role="alert" style={{ padding: '0 12px', overflowWrap: 'anywhere', color: '#ffb4ab' }}>{record.error}</div> : <>
        <div style={{ padding: '0 12px' }}>{connectionSummary(record)}</div>
        {record.appid !== undefined && <div style={caption}>游戏：{record.appid}</div>}
        {record.prefix && <PathLine label="Proton 目录" path={record.prefix} />}
        {record.target && <PathLine label="用户目录" path={record.target} />}
        {record.backup && <PathLine label="原目录备份" path={record.backup} />}
      </>}
  </div>;
}

function Panel({ model, listening }: { model: SettingsController; listening: boolean }) {
  const view = useSyncExternalStore(model.subscribe, model.snapshot);
  const blocked = !view.loaded || Boolean(view.busy);
  return <>
    <PanelSection title="Sync Save · 0.2.4">
      <PanelSectionRow><Focusable flow-children="vertical" style={{ ...stack, fontSize: 14, lineHeight: '20px' }}>
      <div style={{ padding: '0 12px', fontWeight: 600 }}>Windows 用户目录</div>
      <div style={caption}>选择已同步到 Steam Deck 的用户目录，其中应包含 AppData、Documents 等文件夹。</div>
      <ControlButton disabled={blocked} onClick={() => void model.choose()}>
        {view.busy === 'choosing' ? '正在选择…' : '选择目录'}</ControlButton>
      {view.draft.source ? <PathLine label="所选同步目录 · 点击查看完整路径" path={view.draft.source} /> : <div style={caption}>尚未选择目录</div>}
      <ToggleField disabled={blocked} bottomSeparator="none" label={<span style={{ fontSize: 14 }}>游戏启动时自动连接</span>}
        checked={view.draft.enabled} onChange={enabled => model.setEnabled(enabled)} />
      <ControlButton disabled={blocked} onClick={() => void model.save()}>
        {view.busy === 'saving' ? '正在保存…' : '保存设置'}</ControlButton>
      <div role={view.failed ? 'alert' : 'status'} style={{ padding: '6px 12px', overflowWrap: 'anywhere', color: view.failed ? '#ffb4ab' : '#b8c5d3' }}>{view.message}</div>
      <ControlButton disabled={Boolean(view.busy)} onClick={() => void model.refresh()}>
        {view.loaded ? '刷新保存状态与连接记录' : '重新加载设置'}</ControlButton>
      <ConnectionStatus record={view.last} />
      {!listening && <div style={caption}>游戏启动监听不可用，请检查 Decky 与 Steam 客户端版本。</div>}
      <div style={{ ...caption, paddingTop: 6 }}>
        目录发生变化后，插件会提示并请求关闭游戏。请重新启动游戏；原用户目录保留为备份。
      </div>
      </Focusable></PanelSectionRow>
    </PanelSection>
  </>;
}

export default definePlugin(() => {
  const steam = (window as any).SteamClient;
  const model = new SettingsController(backend,
    start => openFilePicker(FileSelectionType.FOLDER, start, false, true), notify);
  const games = new GameRunner(backend, notify, async appid => {
    if (typeof steam?.Apps?.TerminateApp !== 'function') throw new Error('Steam 关闭游戏接口不可用');
    await steam.Apps.TerminateApp(appid, false);
  }, undefined, undefined, record => model.updateRecord(record));
  let subscription: { unregister(): void } | undefined;
  try {
    subscription = steam?.GameSessions?.RegisterForAppLifetimeNotifications(
      (event: { unAppID: number; bRunning: boolean }) => games.event(event.unAppID, event.bRunning));
  } catch (error) { notify(`游戏监听失败：${describeError(error)}`); }
  let previousEnabled: boolean | undefined;
  const unsubscribe = model.subscribe(() => {
    const enabled = model.snapshot().saved?.enabled;
    if (previousEnabled === true && enabled === false) games.cancelAll();
    previousEnabled = enabled;
  });
  void model.refresh();
  return {
    name: 'Sync Save', version: '0.2.4', icon: <span>↔</span>,
    content: <Panel model={model} listening={Boolean(subscription)} />,
    onDismount() {
      unsubscribe(); model.dispose(); games.dispose();
      try { subscription?.unregister(); } catch { /* Steam may already be unavailable. */ }
    },
  };
});
