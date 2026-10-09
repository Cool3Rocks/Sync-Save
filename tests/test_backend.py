import json
import os
import subprocess
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from linker import connect, find_prefix, validate_source
from sync_save_settings import SettingsStore
from main import Plugin


class FilesystemTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.prefix = self.root / 'pfx'
        self.target = self.prefix / 'drive_c/users/steamuser'
        self.target.mkdir(parents=True)
        (self.target / 'save.dat').write_text('original', encoding='utf-8')
        self.source = self.root / '同步目录'
        self.source.mkdir()

    def environment(self, pid, variables):
        process = self.root / 'proc' / str(pid)
        process.mkdir(parents=True)
        (process / 'environ').write_bytes(b'\0'.join(key.encode() + b'=' + os.fsencode(value) for key, value in variables.items()))
        return process.parent

    def require_links(self):
        probe = self.root / 'probe'
        try:
            probe.symlink_to(self.source, target_is_directory=True)
            probe.unlink()
        except OSError:
            self.skipTest('Directory symlinks unavailable on this host')

    def test_real_link_preserves_original_and_is_idempotent(self):
        self.require_links()
        result = connect(self.prefix, self.source)
        self.assertEqual((Path(result['backup']) / 'save.dat').read_text(), 'original')
        self.assertEqual(self.target.resolve(), self.source.resolve())
        self.assertFalse(connect(self.prefix, self.source)['changed'])

    def test_changing_source_keeps_both_backups(self):
        self.require_links()
        first = connect(self.prefix, self.source)
        second_source = self.root / 'second'
        second_source.mkdir()
        second = connect(self.prefix, second_source)
        self.assertEqual(Path(second['backup']).resolve(), self.source.resolve())
        self.assertEqual((Path(first['backup']) / 'save.dat').read_text(), 'original')
        self.assertEqual(self.target.resolve(), second_source.resolve())

    def test_invalid_overlap_leaves_original(self):
        for source in (self.target, self.prefix, self.root):
            with self.assertRaises(ValueError):
                connect(self.prefix, source)
        self.assertEqual((self.target / 'save.dat').read_text(), 'original')

    def test_link_creation_denied_preserves_original(self):
        with patch.object(Path, 'symlink_to', side_effect=PermissionError('denied')):
            with self.assertRaises(PermissionError):
                connect(self.prefix, self.source)
        self.assertEqual((self.target / 'save.dat').read_text(), 'original')

    def test_install_failure_restores_original_and_cleans_temporary(self):
        self.require_links()
        rename = Path.rename
        def failing(path, destination):
            if path.name.startswith('.sync-save-link-'):
                raise OSError('install failed')
            return rename(path, destination)
        with patch.object(Path, 'rename', failing):
            with self.assertRaises(OSError):
                connect(self.prefix, self.source)
        self.assertEqual((self.target / 'save.dat').read_text(), 'original')
        self.assertEqual(list(self.target.parent.glob('.sync-save-link-*')), [])
        self.assertEqual(list(self.target.parent.glob('steamuser.sync-save-backup-*')), [])

    def test_broken_old_link_can_be_replaced_without_losing_it(self):
        self.require_links()
        (self.target / 'save.dat').unlink()
        self.target.rmdir()
        self.target.symlink_to(self.root / 'missing', target_is_directory=True)
        result = connect(self.prefix, self.source)
        self.assertTrue(Path(result['backup']).is_symlink())
        self.assertEqual(self.target.resolve(), self.source.resolve())

    def test_prefix_environment_variants(self):
        appid = 2147483649
        cases = [
            {'SteamAppId': str(appid), 'WINEPREFIX': str(self.prefix)},
            {'STEAM_COMPAT_APP_ID': str(appid), 'STEAM_COMPAT_DATA_PATH': str(self.root)},
            {'SteamGameId': str((appid << 32) | 0x02000000), 'WINEPREFIX': str(self.prefix)},
            {'SteamAppId': str(appid - 2**32), 'WINEPREFIX': str(self.prefix)},
        ]
        for variables in cases:
            proc = self.environment(123, variables)
            self.assertEqual(find_prefix(appid, proc), self.prefix.resolve())
            self.assertIsNone(find_prefix(appid + 1, proc))
            (proc / '123/environ').unlink()
            (proc / '123').rmdir()

    def test_uninitialized_prefix_is_not_modified(self):
        proc = self.environment(123, {'SteamAppId': '2147483649', 'WINEPREFIX': str(self.root / 'new')})
        self.assertIsNone(find_prefix(2147483649, proc))
        with self.assertRaises(ValueError):
            validate_source('')

    def test_ambiguous_prefix_rejected(self):
        proc = self.environment(123, {'SteamAppId': '2147483649', 'WINEPREFIX': str(self.prefix)})
        self.environment(124, {'SteamAppId': '2147483649', 'WINEPREFIX': str(self.root / 'other')})
        with self.assertRaises(ValueError):
            find_prefix(2147483649, proc)

    def test_settings_roundtrip_unicode_and_disable_missing_directory(self):
        store = SettingsStore(self.root / 'settings')
        saved = store.save({'source': str(self.source), 'enabled': True})
        self.assertEqual(SettingsStore(store.path.parent).value, saved)
        disabled = store.save({'source': '/missing/drive', 'enabled': False})
        self.assertEqual(SettingsStore(store.path.parent).value, disabled)

    def test_corrupt_settings_disable_safely(self):
        store = SettingsStore(self.root / 'settings')
        store.path.parent.mkdir()
        for text in ('{bad', '[]', '{"source":"","enabled":"false"}'):
            store.path.write_text(text, encoding='utf-8')
            loaded = SettingsStore(store.path.parent)
            self.assertFalse(loaded.value['enabled'])
            self.assertIsNotNone(loaded.warning)

    def test_failed_atomic_replace_keeps_previous_settings(self):
        store = SettingsStore(self.root / 'settings')
        store.save({'source': '', 'enabled': False})
        before = store.path.read_bytes()
        with patch('sync_save_settings.os.replace', side_effect=PermissionError('read-only settings')):
            with self.assertRaises(PermissionError):
                store.save({'source': str(self.source), 'enabled': True})
        self.assertEqual(store.path.read_bytes(), before)
        self.assertFalse(store.value['enabled'])
        self.assertEqual(list(store.path.parent.glob('*.tmp')), [])

    def test_invalid_settings_never_replace_file(self):
        store = SettingsStore(self.root / 'settings')
        store.save({'source': '', 'enabled': False})
        for payload in (None, {}, {'source': '', 'enabled': 'false'}, {'source': '/missing', 'enabled': True}):
            with self.assertRaises(ValueError):
                store.save(payload)
        self.assertFalse(SettingsStore(store.path.parent).value['enabled'])


class RpcTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        module = types.SimpleNamespace(DECKY_PLUGIN_SETTINGS_DIR=str(self.root / 'settings'))
        patcher = patch.dict(sys.modules, {'decky': module})
        patcher.start()
        self.addCleanup(patcher.stop)
        self.plugin = Plugin()

    async def test_rpc_before_main_and_verified_save(self):
        state = await self.plugin.get_state()
        self.assertTrue(state['ok'])
        saved = await self.plugin.update_settings({'source': str(self.root), 'enabled': True})
        self.assertTrue(saved['ok'])
        self.assertEqual(json.loads(self.plugin.store.path.read_text()), saved['data']['settings'])
        await self.plugin._main()
        self.assertTrue((await self.plugin.get_state())['data']['settings']['enabled'])

    async def test_decky_module_aliases_do_not_break_backend_startup(self):
        # Decky aliases decky_loader.settings as sys.modules['settings'] before
        # importing a plugin. A fresh process reproduces the real import order.
        program = '''
import asyncio, json, sys, types
sys.modules['settings'] = types.ModuleType('decky_loader.settings')
sys.modules['decky'] = types.SimpleNamespace(DECKY_PLUGIN_SETTINGS_DIR=sys.argv[1])
from main import Plugin
async def check():
    plugin = Plugin()
    await plugin._main()
    state = await plugin.get_state()
    assert state['ok'], state
    reply = await plugin.update_settings({'source': '/home/deck/synced', 'enabled': False})
    assert reply['ok'], reply
    assert (await plugin.get_state())['data']['settings']['source'] == '/home/deck/synced'
    print(json.dumps(reply))
asyncio.run(check())
'''
        result = subprocess.run([sys.executable, '-c', program, str(self.root / 'decky-settings')],
                                cwd=Path(__file__).resolve().parents[1], capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(json.loads(result.stdout)['ok'])

    async def test_rpc_returns_permission_failure(self):
        await self.plugin.get_state()
        with patch('sync_save_settings.os.replace', side_effect=PermissionError('settings are read-only')):
            reply = await self.plugin.update_settings({'source': '', 'enabled': False})
        self.assertFalse(reply['ok'])
        self.assertIn('read-only', reply['error'])

    async def test_disabled_and_native_game_do_not_scan(self):
        await self.plugin.get_state()
        with patch('main.find_prefix') as scan:
            self.assertEqual((await self.plugin.process_launch(1))['data']['action'], 'ignored')
            self.assertEqual((await self.plugin.process_launch(2147483649))['data']['action'], 'disabled')
            scan.assert_not_called()

    async def test_waiting_and_connection_error_are_explicit(self):
        await self.plugin.update_settings({'source': str(self.root), 'enabled': True})
        with patch('main.find_prefix', return_value=None):
            self.assertEqual((await self.plugin.process_launch(2147483649))['data']['action'], 'waiting')
            final = await self.plugin.process_launch(2147483649, 44)
            self.assertEqual(final['data']['record']['state'], 'missing')
            self.assertEqual((await self.plugin.get_state())['data']['last']['state'], 'missing')
        with patch('main.find_prefix', side_effect=PermissionError('cannot read proc')):
            self.assertIn('cannot read proc', (await self.plugin.process_launch(2147483649))['error'])
        self.assertIn('error', (await self.plugin.get_state())['data']['last'])

    async def test_launch_reply_carries_current_record_for_panel_refresh(self):
        await self.plugin.update_settings({'source': str(self.root), 'enabled': True})
        record = {'changed': False, 'prefix': str(self.root / 'pfx'), 'target': '/pfx/drive_c/users/steamuser', 'backup': None}
        with patch('main.find_prefix', return_value=self.root / 'pfx'), patch('main.connect', return_value=record):
            reply = await self.plugin.process_launch(2147483649)
        self.assertEqual(reply['data']['record']['target'], record['target'])
        self.assertEqual(reply['data']['record'], (await self.plugin.get_state())['data']['last'])
        await self.plugin.update_settings({'source': '', 'enabled': False})
        reply = await self.plugin.process_launch(2147483649)
        self.assertEqual(reply['data']['record']['state'], 'disabled')

    async def test_refresh_reads_actual_disk(self):
        await self.plugin.get_state()
        self.plugin.store.path.parent.mkdir()
        self.plugin.store.path.write_text(json.dumps({'source': '/changed', 'enabled': False}), encoding='utf-8')
        self.assertEqual((await self.plugin.get_state())['data']['settings']['source'], '/changed')


if __name__ == '__main__':
    unittest.main()
