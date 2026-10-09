"""Resolve active Proton prefixes and preserve original data when linking."""
import os
import uuid
from pathlib import Path


def validate_source(raw):
    if not isinstance(raw, str) or not raw.strip():
        raise ValueError('请先选择已同步的 Windows 用户目录')
    directory = Path(raw).expanduser()
    if not directory.is_absolute() or not directory.is_dir():
        raise ValueError(f'目录不存在或不是本地绝对路径：{raw}')
    directory = directory.resolve(strict=True)
    if directory == Path(directory.anchor):
        raise ValueError('不能选择文件系统根目录')
    if not os.access(directory, os.R_OK | os.W_OK | os.X_OK):
        raise PermissionError(f'同步目录没有读写权限：{directory}')
    return directory


def matches(environment, appid):
    for key in (b'SteamAppId', b'STEAM_COMPAT_APP_ID', b'SteamGameId'):
        try:
            value = int(environment.get(key, b''))
        except ValueError:
            continue
        if (value & 0xffffffff) == appid:
            return True
        if key == b'SteamGameId' and value > 0xffffffff and (value >> 32) == appid:
            return True
    return False


def find_prefix(appid, proc=Path('/proc')):
    candidates = set()
    for process in Path(proc).iterdir():
        if not process.name.isdecimal():
            continue
        try:
            environment = dict(entry.split(b'=', 1) for entry in (process / 'environ').read_bytes().split(b'\0') if b'=' in entry)
            if not matches(environment, appid):
                continue
            wine, compat = environment.get(b'WINEPREFIX'), environment.get(b'STEAM_COMPAT_DATA_PATH')
            if not wine and not compat:
                continue
            prefix = Path(os.fsdecode(wine)) if wine else Path(os.fsdecode(compat)) / 'pfx'
            if prefix.is_absolute():
                candidates.add(prefix.resolve())
        except (OSError, ValueError, RuntimeError):
            continue
    if len(candidates) > 1:
        raise ValueError('检测到多个 Proton prefix，未修改任何存档')
    if not candidates:
        return None
    prefix = candidates.pop()
    target = prefix / 'drive_c/users/steamuser'
    return prefix if target.is_dir() or target.is_symlink() else None


def connect(prefix, raw_source):
    prefix = Path(prefix).resolve(strict=True)
    source = validate_source(str(raw_source))
    drive, users = prefix / 'drive_c', prefix / 'drive_c/users'
    if drive.is_symlink() or users.is_symlink() or not users.is_dir():
        raise ValueError('Proton 用户目录结构无效')
    if source == prefix or prefix in source.parents or source in prefix.parents:
        raise ValueError('同步目录不能与 Proton prefix 重叠')
    target = users / 'steamuser'
    if not os.path.lexists(target):
        raise ValueError('Proton 尚未创建 steamuser，请重新启动游戏后重试')
    resolved = target.resolve()
    if target.is_symlink() and resolved == source:
        return {'changed': False, 'prefix': str(prefix), 'target': str(target), 'backup': None}
    if not target.is_symlink() and not target.is_dir():
        raise ValueError('steamuser 不是目录，未修改')
    if source == resolved or resolved in source.parents or source in resolved.parents:
        raise ValueError('同步目录与现有用户目录重叠，未修改')
    identity = uuid.uuid4().hex
    temporary = users / f'.sync-save-link-{identity}'
    backup = users / f'steamuser.sync-save-backup-{identity}'
    moved = False
    try:
        temporary.symlink_to(source, target_is_directory=True)
        target.rename(backup)
        moved = True
        temporary.rename(target)
    except BaseException as error:
        if moved:
            if os.path.lexists(target):
                raise RuntimeError(f'原目录保存在 {backup}；目标被其他进程创建，请手动检查') from error
            try:
                backup.rename(target)
            except OSError as rollback:
                raise RuntimeError(f'回滚失败，原目录保存在 {backup}：{rollback}') from error
        raise
    finally:
        if temporary.is_symlink():
            temporary.unlink()
    return {'changed': True, 'prefix': str(prefix), 'target': str(target), 'backup': str(backup)}
