"""Package only the release files, checking completeness and zip integrity."""
import json
from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED

root = Path(__file__).resolve().parents[1]
version = json.loads((root / 'package.json').read_text(encoding='utf-8'))['version']
files = ['plugin.json', 'package.json', 'main.py', 'sync_save_settings.py', 'linker.py',
         'README.md', 'REQUIREMENTS.md', 'DEBUGGING.md', 'dist/index.js']
for name in files:
    if not (root / name).is_file():
        raise SystemExit(f'Missing release file: {name}')
output = root / 'artifacts' / f'Sync-Save-{version}.zip'
output.parent.mkdir(exist_ok=True)
pending = output.with_suffix('.tmp')
with ZipFile(pending, 'w', ZIP_DEFLATED) as archive:
    for name in files:
        archive.write(root / name, 'SyncSave/' + name)
with ZipFile(pending) as archive:
    if archive.testzip() is not None:
        raise SystemExit('Archive integrity failed')
    for name in files:
        if archive.read('SyncSave/' + name) != (root / name).read_bytes():
            raise SystemExit(f'Archive mismatch: {name}')
pending.replace(output)
(root / 'artifacts/Sync-Save.zip').write_bytes(output.read_bytes())
print(output)
