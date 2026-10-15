# -*- coding: utf-8 -*-
"""查火绒 HipsSysAuto_60（自动放行记录）+ HrTrayMsg/UserTrack，确认规则是否已被记住允许。"""
import shutil, sqlite3, os, datetime

base = 'C:/ProgramData/Huorong/Sysdiag'
tmp = 'C:/Users/jingt/AppData/Local/Temp/hrcopy'
os.makedirs(tmp, exist_ok=True)

def copy_db(name):
    dst = os.path.join(tmp, name)
    for suf in ['', '-wal', '-shm']:
        src = base + '/' + name + suf
        if os.path.exists(src):
            try: shutil.copy2(src, dst + suf)
            except Exception: pass
    return dst

def fmt(ts):
    try:
        ts = float(ts)
    except Exception:
        return str(ts)
    for div, off in ((10**7, 11644473600), (1.0, 0.0)):
        u = ts / div - off
        if 1.5e9 < u < 2.2e9:
            return (datetime.datetime.fromtimestamp(u, datetime.timezone.utc)
                    + datetime.timedelta(hours=8)).strftime('%Y-%m-%d %H:%M:%S')
    return str(ts)

for dbname, tbls in [('hips.db', ['HipsSysAuto_60']), ('log.db', ['HrTrayMsg_60', 'UserTrack_60'])]:
    dst = copy_db(dbname)
    con = sqlite3.connect('file:' + dst + '?mode=ro', uri=True)
    for t in tbls:
        try:
            rows = con.execute('SELECT * FROM %s ORDER BY rowid DESC LIMIT 10' % t).fetchall()
            print('=== %s / %s（%d 行）===' % (dbname, t, len(rows)))
            for r in rows:
                print('   ', str(r)[:400])
        except Exception as e:
            print('  ERR', t, e)
    con.close()
    print()
