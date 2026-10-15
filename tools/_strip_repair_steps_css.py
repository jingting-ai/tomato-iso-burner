# -*- coding: utf-8 -*-
"""删除 styles.css 里已废弃的 .repair-steps / .repair-step 样式段"""
p = 'src/renderer/src/styles.css'
lines = open(p, encoding='utf-8').read().split('\n')
a = next(i for i, l in enumerate(lines) if '.repair-steps' in l and '/*' not in l)
# 回溯到它上面的注释行（/* ---------- ... */）
c = a - 1
while c >= 0 and not lines[c].strip().startswith('/*'):
    c -= 1
b = next(i for i, l in enumerate(lines) if i > a and l.strip().startswith('.repair-step {'))
while lines[b].strip() != '}':
    b += 1
print('删除区间: 行 %d .. %d' % (c + 1, b + 1))
del lines[c:b + 1]
open(p, 'w', encoding='utf-8').write('\n'.join(lines))
print('OK')
