const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const cache = new Map();
function load(name) {
  if (cache.has(name)) return cache.get(name);
  const filename = path.join(__dirname, '../src', name + '.ts');
  const output = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const module = { exports: {} };
  new Function('require', 'module', 'exports', output)(request => load(request.replace('./', '')), module, module.exports);
  cache.set(name, module.exports);
  return module.exports;
}
const { SettingsController, recordText } = load('controller');
const { GameRunner } = load('games');
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const success = data => ({ ok: true, data });
function fixture() {
  const state = { settings: { source: '/home/deck/saved', enabled: false }, last: null, warning: null };
  const notes = [], calls = [];
  const backend = {
    read: async () => success(structuredClone(state)),
    save: async settings => { calls.push(settings); state.settings = { ...settings }; return success(structuredClone(state)); },
    launch: async () => success({ action: 'unchanged' }),
  };
  const model = new SettingsController(backend, async () => ({ path: '/home/deck/new', realpath: '/home/deck/new' }), note => notes.push(note), 25);
  return { model, state, backend, notes, calls };
}

test('directory selection survives panel unsubscribe and resubscribe', async () => {
  const f = fixture();
  const choice = deferred();
  const model = new SettingsController(f.backend, () => choice.promise, note => f.notes.push(note));
  await model.refresh();
  const unsubscribe = model.subscribe(() => {});
  const choosing = model.choose();
  unsubscribe(); // Decky closes/recreates the panel while a modal is open.
  choice.resolve({ path: '/home/deck/alias', realpath: '/mnt/sync/user' });
  await choosing;
  const nextSubscription = model.subscribe(() => {});
  assert.equal(model.snapshot().draft.source, '/mnt/sync/user');
  model.setEnabled(true);
  await model.save();
  assert.deepEqual(f.calls[0], { source: '/mnt/sync/user', enabled: true });
  assert.equal(model.snapshot().saved.source, '/mnt/sync/user');
  assert.match(f.notes.at(-1), /设置已保存/);
  nextSubscription(); model.dispose();
});

test('refresh preserves unsaved selection while updating persisted state and record', async () => {
  const f = fixture(); await f.model.refresh(); await f.model.choose(); f.model.setEnabled(true);
  f.state.last = { appid: 42, changed: true, backup: '/backup' };
  await f.model.refresh();
  assert.equal(f.model.snapshot().draft.source, '/home/deck/new');
  assert.equal(f.model.snapshot().draft.enabled, true);
  assert.equal(f.model.snapshot().saved.source, '/home/deck/saved');
  assert.equal(f.model.snapshot().last.appid, 42);
  assert.equal(recordText(null), '暂无连接记录');
  assert.match(recordText(f.model.snapshot().last), /\/backup/);
});

test('save failure, incompatible response and timeout never report success', async () => {
  const f = fixture(); await f.model.refresh();
  f.backend.save = async () => ({ ok: false, error: '配置目录只读' });
  await f.model.save();
  assert.equal(f.model.snapshot().failed, true);
  assert.match(f.notes.at(-1), /只读/);
  f.backend.save = async () => ({});
  await f.model.save(); assert.match(f.notes.at(-1), /响应格式不匹配/);
  f.backend.save = async () => new Promise(() => {});
  await f.model.save();
  assert.match(f.notes.at(-1), /保存结果可能尚未确认/);
  assert.equal(f.model.snapshot().busy, null);
  assert.ok(!f.notes.some(note => note.includes('设置已保存')));
});

test('loading blocks edits and a failed read can be retried', async () => {
  const f = fixture(); f.backend.read = async () => { throw { message: 'offline' }; };
  f.model.setEnabled(true); await f.model.choose();
  assert.equal(f.model.snapshot().draft.enabled, false);
  await f.model.refresh(); assert.equal(f.model.snapshot().loaded, false);
  assert.match(f.model.snapshot().message, /offline/);
  f.backend.read = async () => success(f.state);
  await f.model.refresh(); assert.equal(f.model.snapshot().loaded, true);
});

test('cancelling picker preserves draft and releasing duplicate save clicks', async () => {
  const f = fixture();
  const model = new SettingsController(f.backend, async () => { throw 'User canceled'; }, () => {});
  await model.refresh(); const before = model.snapshot().draft;
  await model.choose(); assert.deepEqual(model.snapshot().draft, before);
  const pending = deferred(); f.backend.save = () => pending.promise;
  const first = model.save(); const second = model.save();
  assert.equal(model.snapshot().busy, 'saving');
  pending.resolve(success(f.state)); await Promise.all([first, second]);
  assert.equal(model.snapshot().busy, null);
});

test('disabled, Steam and unchanged launches do not terminate', async () => {
  const f = fixture(); let closed = 0, calls = 0;
  f.backend.launch = async () => { calls++; return success({ action: 'unchanged' }); };
  const runner = new GameRunner(f.backend, () => {}, async () => { closed++; });
  runner.event(123, true); runner.event(2147483649, true); runner.event(2147483649, true);
  await tick(); assert.equal(calls, 1); assert.equal(closed, 0); runner.dispose();
});

test('link changes request shutdown only after five seconds and stop cancels it', async () => {
  const f = fixture(), sleeps = [], closed = [];
  f.backend.launch = async () => success({ action: 'linked' });
  const runner = new GameRunner(f.backend, note => f.notes.push(note), async appid => closed.push(appid),
    (delay, signal) => { const wait = deferred(); sleeps.push({ delay, signal, resolve: wait.resolve }); return wait.promise; });
  runner.event(2147483649, true); await tick();
  assert.equal(sleeps[0].delay, 5000); assert.equal(closed.length, 0);
  sleeps[0].resolve(); await tick(); assert.deepEqual(closed, ['2147483649']);
  runner.event(2147483649, false); runner.event(2147483649, true); await tick();
  runner.event(2147483649, false); assert.equal(sleeps[1].signal.aborted, true);
  sleeps[1].resolve(); await tick(); assert.equal(closed.length, 1);
  runner.dispose();
});

test('unloading during an RPC suppresses notifications and shutdown', async () => {
  const f = fixture(), pending = deferred(); let closed = false;
  f.backend.launch = () => pending.promise;
  const runner = new GameRunner(f.backend, note => f.notes.push(note), async () => { closed = true; });
  runner.event(2147483649, true); runner.dispose();
  pending.resolve(success({ action: 'linked' })); await tick();
  assert.equal(closed, false); assert.equal(f.notes.length, 0);
});

test('prefix polling stops at 45 attempts and shutdown errors ask for manual exit', async () => {
  const f = fixture(); let calls = 0;
  f.backend.launch = async () => { calls++; return success({ action: 'waiting' }); };
  const runner = new GameRunner(f.backend, note => f.notes.push(note), async () => {}, async () => {});
  runner.event(2147483649, true); await tick();
  assert.equal(calls, 45); assert.match(f.notes.at(-1), /未找到/); runner.dispose();
  f.backend.launch = async () => success({ action: 'linked' });
  const failed = new GameRunner(f.backend, note => f.notes.push(note), async () => { throw new Error('unsupported'); }, async () => {});
  failed.event(2147483649, true); await tick();
  assert.match(f.notes.at(-1), /手动退出.*unsupported/); failed.dispose();
});

test('game results update records while preserving drafts and late save responses cannot erase them', async () => {
  const f = fixture(); await f.model.refresh(); await f.model.choose(); f.model.setEnabled(true);
  const pending = deferred();
  f.backend.save = () => pending.promise;
  const saving = f.model.save();
  const originalDraft = { ...f.model.snapshot().draft };
  const record = { appid: 2147483649, changed: false, target: '/pfx/drive_c/users/steamuser' };
  f.backend.launch = async () => success({ action: 'unchanged', record });
  const runner = new GameRunner(f.backend, () => {}, async () => {}, undefined, undefined,
    value => f.model.updateRecord(value));
  runner.event(2147483649, true);
  assert.equal(f.model.snapshot().last.state, 'checking');
  await tick();
  assert.equal(f.model.snapshot().last.target, record.target);
  assert.deepEqual(f.model.snapshot().draft, originalDraft);
  assert.equal(f.model.snapshot().busy, 'saving');
  pending.resolve(success({ ...f.state, settings: originalDraft })); await saving;
  assert.equal(f.model.snapshot().last.target, record.target);
  runner.dispose();
});

test('waiting and connection failures automatically replace the previous record', async () => {
  const f = fixture(); await f.model.refresh();
  const next = deferred(); let calls = 0;
  f.backend.launch = async () => ++calls === 1 ? success({ action: 'waiting' }) : next.promise;
  const runner = new GameRunner(f.backend, () => {}, async () => {}, async () => {}, 25,
    value => f.model.updateRecord(value));
  runner.event(2147483649, true); await tick();
  assert.equal(f.model.snapshot().last.state, 'waiting');
  next.resolve({ ok: false, error: 'sync drive unavailable' }); await tick();
  assert.equal(f.model.snapshot().last.error, 'sync drive unavailable');
  runner.dispose();
});

test('built plugin initializes and automatically refreshes a launched game record', async () => {
  const vm = require('node:vm');
  const f = fixture(), notifications = [];
  const api = { _version: 2, callable: route => (...args) => ({ get_state: f.backend.read, update_settings: f.backend.save, process_launch: f.backend.launch }[route])(...args),
    toaster: { toast: value => notifications.push(value) }, openFilePicker: async () => ({ path: '/home/deck/new' }) };
  const jsx = (type, props) => ({ type, props });
  let gameEvent;
  const context = { window: { __DECKY_SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED_deckyLoaderAPIInit: { connect: () => api },
    SteamClient: { GameSessions: { RegisterForAppLifetimeNotifications: listener => { gameEvent = listener; return { unregister() {} }; } } } },
    SP_REACT: { useSyncExternalStore: (_, snapshot) => snapshot() }, SP_JSX: { jsx, jsxs: jsx, Fragment: 'fragment' },
    DFL: { PanelSection: 'section', PanelSectionRow: 'row', Focusable: 'group', DialogButton: 'button', ToggleField: 'toggle', ConfirmModal: 'modal', showModal: () => {} },
    console, setTimeout, clearTimeout, AbortController };
  vm.createContext(context);
  const bundle = fs.readFileSync(path.join(__dirname, '../dist/index.js'), 'utf8').replace(/export\s*\{[^}]*\};/, '');
  vm.runInContext(bundle + '\nglobalThis.entry = index;', context);
  const plugin = context.entry(); await tick();
  assert.equal(plugin.version, '0.2.4');
  const content = plugin.content.type(plugin.content.props);
  assert.match(content.props.children.props.title, /0.2.4/);
  const model = plugin.content.props.model;
  await model.choose(); await model.save();
  assert.equal(f.state.settings.source, '/home/deck/new');
  assert.equal(notifications.at(-1).showToast, true);
  const record = { appid: 2147483649, changed: false, prefix: '/real/pfx' };
  f.backend.launch = async () => success({ action: 'unchanged', record });
  gameEvent({ unAppID: 2147483649, bRunning: true }); await tick();
  assert.equal(model.snapshot().last.prefix, '/real/pfx');
  plugin.onDismount();
});
