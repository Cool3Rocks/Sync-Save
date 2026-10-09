"""Validated settings with atomic writes and read-back confirmation."""
import json
import os
import tempfile
from pathlib import Path
from linker import validate_source


class SettingsStore:
    def __init__(self, directory):
        self.path = Path(directory) / 'settings.json'
        self.reload()

    def reload(self):
        self.value = {'source': '', 'enabled': False}
        self.warning = None
        try:
            if self.path.exists():
                self.value = self.decode(self.path.read_text(encoding='utf-8'))
        except (OSError, ValueError) as error:
            self.warning = f'原配置无法读取，自动连接已关闭：{error}'

    @staticmethod
    def decode(text):
        data = json.loads(text)
        if not isinstance(data, dict) or not isinstance(data.get('source'), str) or type(data.get('enabled')) is not bool:
            raise ValueError('配置格式无效')
        return {'source': data['source'], 'enabled': data['enabled']}

    def save(self, payload):
        if not isinstance(payload, dict):
            raise ValueError('设置参数格式无效')
        source, enabled = payload.get('source'), payload.get('enabled')
        if not isinstance(source, str) or type(enabled) is not bool:
            raise ValueError('需要目录路径和布尔类型的自动连接开关')
        if enabled:
            source = str(validate_source(source))
        value = {'source': source, 'enabled': enabled}
        self.path.parent.mkdir(parents=True, exist_ok=True)
        pending = None
        try:
            with tempfile.NamedTemporaryFile(mode='w', encoding='utf-8', dir=self.path.parent,
                                             prefix='.sync-save-', suffix='.tmp', delete=False) as stream:
                pending = Path(stream.name)
                json.dump(value, stream, ensure_ascii=False)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(pending, self.path)
            verified = self.decode(self.path.read_text(encoding='utf-8'))
            if verified != value:
                raise OSError('写入后回读不一致，请刷新确认保存结果')
            self.value, self.warning = verified, None
            return dict(verified)
        finally:
            if pending is not None and pending.exists():
                pending.unlink()
