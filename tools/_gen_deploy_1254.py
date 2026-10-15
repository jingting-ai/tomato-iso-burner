# -*- coding: utf-8 -*-
"""由 _deploy_1253.sh 生成 _deploy_1254.sh。

延续 1.2.53 的做法：
  ① 全文替换版本号 / 说明书名 / 效果图计数的版本号；
  ② 效果图拷贝行保留「还原窗口那批截图」；
  ③ 校验段整体替换为 1.2.54 的新版（按起止标记行定位）。
"""
lines = open('tools/_deploy_1253.sh', encoding='utf-8').read().split('\n')
out = []
for ln in lines:
    ln = (ln.replace('1.2.53', '1.2.54')
           .replace('_readme_1253.txt', '_readme_1254.txt')
           .replace('使用说明-1.2.53.txt', '使用说明-1.2.54.txt')
           .replace('v1.2.53 部署', 'v1.2.54 部署')
           .replace('界面效果-1\\.2\\.53', '界面效果-1\\.2\\.54'))
    out.append(ln)

# ---- 校验段整体替换：从「本版改动」到「每 10% / 60s 心跳」那一行 ----
start = next(i for i, l in enumerate(out) if '本版改动' in l)
end = next(i for i, l in enumerate(out) if '每 10% / 60s 心跳' in l)
new_block = r'''  // ---- 本版改动（1.2.54）----
  // -- ① 安装包首次安装不弹确认框：build/installer.nsh \$R0=="" 时直接 Goto，没有 MessageBox。
  //    installer.nsh 不打包进 asar，这一行只作说明，不参加失败判定。
  console.log('  [说明] 全新安装不弹窗       : 见 build/installer.nsh');
  // -- ② 还原窗口可上下滚动 --
  console.log('  还原窗口 flex 纵向布局      :', has('.restore.restore-win') && has('display') && has('flex-direction') && has('column'));
  console.log('  还原窗口内容区可滚动        :', has('.restore-body') && has('overflow-y:auto'));
  // -- ③ 老功能别丢 --
  console.log('  createRestoreWindow         :', has('createRestoreWindow'));
  console.log('  restore:open/close          :', has('restore:open') && has('restore:close'));
  console.log('  副标题=工具介绍             :', has('开源免费 · 本地离线 · 把镜像写入 U 盘'));
  console.log('  progressLine 进度日志       :', has('progressLine'));
  console.log('  任务开始首条日志            :', has('刻录任务开始'));
  console.log('  每 10% / 60s 心跳           :', has('已写入') && has('已校验') && /6e4|60000/.test(s));'''
old_block = '\n'.join(out[start:end + 1])
assert old_block in '\n'.join(out), '校验段定位失败'
s = '\n'.join(out).replace(old_block, new_block)

open('tools/_deploy_1254.sh', 'w', encoding='utf-8', newline='\n').write(s)
print('已生成 tools/_deploy_1254.sh（校验段第 %d~%d 行已替换）' % (start + 1, end + 1))
