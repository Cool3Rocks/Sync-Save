"""Decky adapter: explicit RPC results and initialization before every request."""
import asyncio
import os
import sys
from datetime import datetime, timezone
sys.path.insert(0, os.path.dirname(__file__))
from linker import connect, find_prefix
from sync_save_settings import SettingsStore


class Plugin:
    def _ready(self):
        if not hasattr(self, 'store'):
            import decky
            self.store = SettingsStore(decky.DECKY_PLUGIN_SETTINGS_DIR)
            self.lock = asyncio.Lock()
            self.last = None

    def _snapshot(self):
        return {'settings': dict(self.store.value), 'last': self.last, 'warning': self.store.warning}

    async def _main(self):
        self._ready()

    async def get_state(self):
        try:
            self._ready()
            async with self.lock:
                self.store.reload()
                return {'ok': True, 'data': self._snapshot()}
        except Exception as error:
            return {'ok': False, 'error': f'读取设置失败：{error}'}

    async def update_settings(self, payload):
        try:
            self._ready()
            async with self.lock:
                self.store.save(payload)
                return {'ok': True, 'data': self._snapshot()}
        except Exception as error:
            return {'ok': False, 'error': f'保存设置失败：{error}'}

    async def process_launch(self, appid, attempt=0):
        try:
            self._ready()
            if type(appid) is not int or not 0 <= appid <= 0xffffffff:
                raise ValueError('游戏 AppID 格式无效')
            if type(attempt) is not int or not 0 <= attempt < 45:
                raise ValueError('检查次数格式无效')
            if not appid & 0x80000000:
                return {'ok': True, 'data': {'action': 'ignored'}}
            async with self.lock:
                if not self.store.value['enabled']:
                    self.last = {'appid': appid, 'state': 'disabled'}
                    return {'ok': True, 'data': {'action': 'disabled', 'record': dict(self.last)}}
                prefix = await asyncio.to_thread(find_prefix, appid)
                if prefix is None:
                    state = 'missing' if attempt == 44 else 'waiting'
                    self.last = {'appid': appid, 'state': state}
                    return {'ok': True, 'data': {'action': state, 'record': dict(self.last)}}
                result = await asyncio.to_thread(connect, prefix, self.store.value['source'])
                self.last = {**result, 'appid': appid, 'time': datetime.now(timezone.utc).isoformat()}
                return {'ok': True, 'data': {'action': 'linked' if result['changed'] else 'unchanged', 'record': dict(self.last)}}
        except Exception as error:
            if hasattr(self, 'last'):
                self.last = {'appid': appid, 'error': str(error)}
            return {'ok': False, 'error': f'连接目录失败：{error}'}

    async def _unload(self):
        pass
