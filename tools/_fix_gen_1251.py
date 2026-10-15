# -*- coding: utf-8 -*-
"""把生成器恢复干净：卷标/图标改到主进程做，repair.ps1 只保留 Label 参数（给存储兜底用）"""
p = 'tools/_gen_repair_ps1.py'
lines = open(p, encoding='utf-8').read().split('\n')

# 1) 参数块：去掉 IconFile 两行，Label 行补回结尾逗号
i = next(i for i, l in enumerate(lines) if l.startswith('"  [string]$Label'))
lines[i] = '"  [string]$Label = ' + chr(39) + '番茄U盘' + chr(39) + '  # 卷标（存储兜底路径会用；最终由主进程 Set-Volume 统一设）",'
# 删掉紧随其后的 IconFile 注释行与参数行（两行）
j = i + 1
if 'tomato logo' in lines[j]:
    del lines[j:j + 2]
    print('已移除 IconFile 参数（改由主进程写图标）')

# 2) 删除插入的「卷标与图标」整块（从注释行到它的收尾 "}"）
k = next(i for i, l in enumerate(lines) if '卷标与图标' in l)
end = k
depth = 0
while True:
    if lines[end].strip() == '"}"':
        break
    end += 1
print('删除卷标/图标块: 行 %d .. %d' % (k + 1, end + 1))
del lines[k:end + 1]

open(p, 'w', encoding='utf-8').write('\n'.join(lines))
print('OK')
