# -*- coding: utf-8 -*-
"""由 _deploy_1251.sh 生成 _deploy_1253.sh（1.2.52 的中间改动直接并进 1.2.53，未单独发版）。

不搞大段精确匹配（引号转义层级太容易抄错），改成按标记行切片：
  ① 全文替换版本号 / 说明书名 / 效果图计数的版本号；
  ② 效果图拷贝行后补一行（还原窗口那批截图）；
  ③ 「本版三条改动」整段校验换成 1.2.53 的新版（按起止标记行定位）。
     ⚠️ 校验项只挑「压缩后一定还在」的：字符串字面量、主进程顶层函数名、CSS 类名。
     （组件内部的表达式文本会被压缩变形，写了也是假阴性，所以不写。）
"""
lines = open('tools/_deploy_1251.sh', encoding='utf-8').read().split('\n')
out = []
for ln in lines:
    ln = (ln.replace('1.2.51', '1.2.53')
           .replace('_readme_1251.txt', '_readme_1253.txt')
           .replace('使用说明-1.2.51.txt', '使用说明-1.2.53.txt')
           .replace('v1.2.51 部署', 'v1.2.53 部署')
           .replace('界面效果-1\\.2\\.42', '界面效果-1\\.2\\.53'))
    out.append(ln)
    # 效果图：主界面那批 + 还原窗口那批
    if ln.strip().startswith('cp dist/_uicheck/gallery/界面效果-'):
        out.append('  cp dist/_uicheck/restore/界面效果-$V*.png  "$DST/" 2>/dev/null')

# ---- 校验段整体替换：从「本版三条改动」到「每 10% / 60s 心跳」那一行 ----
start = next(i for i, l in enumerate(out) if '本版三条改动' in l)
end = next(i for i, l in enumerate(out) if '每 10% / 60s 心跳' in l)
new_block = '''  // ---- 本版改动（1.2.53）----
  // -- ① U 盘还原 = 独立窗口 --
  console.log('  createRestoreWindow     :', has('createRestoreWindow'));
  console.log('  restore:open/close      :', has('restore:open')&&has('restore:close'));
  console.log('  .restore-head 合并标题栏:', has('restore-head')&&has('restore-body'));
  console.log('  还原窗口文案            :', has('选择要还原的 U 盘') && has('将 U 盘还原到初始空 U 盘'));
  console.log('  还原默认 NTFS+番茄U盘   :', has('番茄U盘'));
  console.log('  还原完成文案            :', has('还原完成：U 盘已恢复为'));
  // -- ② 刻录与还原互斥 + 事件按窗口投递 --
  console.log('  jobRunning 互斥闸       :', has('jobRunning'));
  console.log('  事件按窗口投递          :', has('eventTarget'));
  // -- ③ 老功能别丢 --
  console.log('  捐赠直达 openAbout      :', s.indexOf('openAbout("donate")')>=0);
  console.log('  副标题=工具介绍         :', has('开源免费 · 本地离线 · 把镜像写入 U 盘'));
  console.log('  progressLine 进度日志   :', has('progressLine'));
  console.log('  任务开始首条日志        :', has('刻录任务开始'));
  console.log('  每 10% / 60s 心跳       :', has('已写入') && has('已校验') && /6e4|60000/.test(s));'''
old_block = '\n'.join(out[start:end + 1])
assert old_block in '\n'.join(out), '校验段定位失败'
s = '\n'.join(out).replace(old_block, new_block)

open('tools/_deploy_1253.sh', 'w', encoding='utf-8', newline='\n').write(s)
print('已生成 tools/_deploy_1253.sh（校验段第 %d~%d 行已替换）' % (start + 1, end + 1))
