#!/usr/bin/env bash
# v1.2.43 部署
#   ① 完整目录版：additive 铺到 E:\番茄镜像刻录工具\（旧效果图 / 用户自己的东西一概不动）
#   ② ★单文件绿色版：拷成 E:\番茄镜像刻录工具-绿色版.exe —— 用户要的「就一个 exe」
#   ③ 桌面快捷方式改指那个单文件（原来是指向目录版里的 exe）
set -u
cd "E:/开发/Doro镜像刻录工具" || exit 1

V=1.2.43
SRC="dist/win-unpacked"
DST="E:/番茄镜像刻录工具"
GREEN="E:/番茄镜像刻录工具-绿色版.exe"
RC=0

echo "=== ① 写入 $DST ==="
mkdir -p "$DST/安装包" "$DST/修复U盘"

if cp -r "$SRC/." "$DST/" 2>/tmp/_deploy_err; then

  cp "dist/番茄镜像刻录工具-$V-win-x64.exe"  "$DST/安装包/"
  cp "dist/番茄镜像刻录工具-$V-portable.exe" "$DST/安装包/"
  cp "dist/番茄镜像刻录工具-$V-win-x64.zip"  "$DST/安装包/"

  cp dist/_uicheck/gallery/界面效果-$V*.png "$DST/" 2>/dev/null
  cp "tools/_readme_1243.txt"                "$DST/使用说明-$V.txt"
  cp "dist/TomatoIsoBurner-win32-x64-v$V/VERSION.txt" "$DST/VERSION.txt"

  cp "tools/更新番茄刻录工具到最新版.cmd" "$DST/"
  cp "tools/查看当前版本.cmd"             "$DST/"
  cp "tools/刷新任务栏图标.cmd"           "$DST/"
  # 万一单文件绿色版还是打不开：双击它跑一次自查（进程起没起来 / 有没有异常日志）
  cp "tools/绿色版启动自查.cmd"           "$DST/"
  # 桌面那两个辅助脚本也跟着同步（GBK，内容与 tools/ 下的完全一致）
  cp "tools/查看当前版本.cmd"             "C:/Users/jingt/Desktop/查看番茄镜像刻录工具版本.cmd"
  cp "tools/更新番茄刻录工具到最新版.cmd" "C:/Users/jingt/Desktop/更新番茄镜像刻录工具到最新版.cmd"

  # 修复U盘：脚本从工程现取，别用旧副本
  cp assets/burn.ps1              "$DST/修复U盘/"
  cp tools/修复U盘.ps1             "$DST/修复U盘/"
  cp tools/一键修复U盘.cmd         "$DST/修复U盘/"
  cp tools/一键更新安装版.cmd      "$DST/修复U盘/"
  cp tools/同步脚本到安装版.ps1    "$DST/修复U盘/"

  echo "  OK，文件数: $(find "$DST" -type f | wc -l)"
else
  echo "  !! 写入失败。前几条错误："
  head -3 /tmp/_deploy_err | sed 's/^/     /'
  RC=1
fi

echo
echo "=== ② 单文件绿色版 -> $GREEN ==="
if cp "dist/番茄镜像刻录工具-$V-portable.exe" "$GREEN"; then
  ls -la "$GREEN"
else
  echo "  !! 拷贝失败"
  RC=1
fi

echo
echo "=== ③ 桌面快捷方式改指单文件绿色版 ==="
PY="C:/Users/jingt/.workbuddy/binaries/python/versions/3.13.12/python.exe"
if [ -x "$PY" ]; then
  "$PY" tools/make-shortcut.py write \
    "C:/Users/jingt/Desktop/番茄镜像刻录工具.lnk" \
    "$GREEN" "" "$GREEN" "番茄镜像刻录工具（绿色版·单文件）" || RC=1
  "$PY" tools/make-shortcut.py read "C:/Users/jingt/Desktop/番茄镜像刻录工具.lnk" || RC=1
else
  echo "  !! 找不到 python，跳过"
fi

echo
echo "=== 校验 ==="
node -e "
const fs=require('fs');
const DST='E:/番茄镜像刻录工具';
const GREEN='E:/番茄镜像刻录工具-绿色版.exe';
const exe=DST+'/番茄镜像刻录工具.exe';
const asar=DST+'/resources/app.asar';
console.log('目录版主程序 :', fs.existsSync(exe) ? (fs.statSync(exe).size/1048576).toFixed(1)+' MB' : '缺失 !!');
console.log('单文件绿色版 :', fs.existsSync(GREEN) ? (fs.statSync(GREEN).size/1048576).toFixed(1)+' MB' : '缺失 !!');
if (fs.existsSync(asar)) {
  const s=fs.readFileSync(asar,'utf8');   // ⚠️ 必须 utf8：latin1 读不出中文，会假阴性
  const n=(t)=>{let c=0,i=0;while((i=s.indexOf(t,i))>=0){c++;i+=t.length}return c};
  const has=(t)=>n(t)>0;
  console.log('asar 含 1.2.43:', has('1.2.43'));
  console.log('asar 残留 Doro :', n('Doro镜像刻录工具')===0, '(x'+n('Doro镜像刻录工具')+')');
  // ---- 本版三条改动 ----
  console.log('-- ① 关于 / 捐赠 = 独立窗口 --');
  console.log('  createAboutWindow       :', has('createAboutWindow'));
  console.log('  about:open/close/goto   :', has('about:open')&&has('about:close')&&has('about:goto'));
  console.log('  .about-win 铺满窗口     :', has('about-win'));
  console.log('  已无弹层自愈(反)        :', n('关于面板未落地，强制重挂一次')===0);
  // ⚠️ 包里是压缩过的代码：openAbout 调用的引号会变双引号、60000 会被压成 6e4。
  //    这里的内联脚本整体处在 bash 的双引号里，所以脚本里的双引号一律要写成 \"。
  console.log('  捐赠直达 openAbout      :', s.indexOf('openAbout(\"donate\")')>=0);
  console.log('-- ② 顶栏统一 + 副标题 --');
  console.log('  副标题=工具介绍         :', has('开源免费 · 本地离线 · 把镜像写入 U 盘'));
  console.log('-- ③ 刻录过程日志 --');
  console.log('  progressLine 进度日志   :', has('progressLine'));
  console.log('  任务开始首条日志        :', has('刻录任务开始'));
  console.log('  每 10% / 60s 心跳       :', has('已写入') && has('已校验') && /6e4|60000/.test(s));
  // ---- 不该出现的 ----
  for (const t of ['打开「关于 / 捐赠」面板','关于面板渲染结果','点击「关于」入口','Windows 镜像刻录工具 · 本地离线运行']) {
    console.log(('  已去掉 '+t).slice(0,32).padEnd(34,' ')+':', n(t)===0, '(残留 x'+n(t)+')');
  }
} else { console.log('asar 缺失 !!') }
// burn.ps1 是 extraResource，不在 asar 里，单独查它的版本标记
try {
  const bp = fs.readFileSync(DST + '/resources/burn.ps1', 'utf8');
  console.log('burn.ps1 版本标记           :', bp.includes('burn-1.2.6-r1') ? 'burn-1.2.6-r1（幽灵分区修复）' : '!! 还是旧版');
  console.log('burn.ps1 残留旧标记(反)     :', !bp.includes('burn-1.2.5-r7'));
  // 旧标记只允许出现在注释里；用户可见的「恢复提示」里绝不能再有写死的旧路径
  console.log('burn.ps1 恢复提示无旧路径(反):', !bp.includes('这是可以恢复的：运行「E:\\番茄镜像刻录工具-1.2.4'));
} catch (e) { console.log('burn.ps1 读取失败 !!', e.message) }
console.log('VERSION.txt  :', fs.existsSync(DST+'/VERSION.txt') ? fs.readFileSync(DST+'/VERSION.txt','utf8').split('\n')[1] : '缺失 !!');
for (const n of ['修复U盘/修复U盘.ps1','使用说明-1.2.43.txt','刷新任务栏图标.cmd','查看当前版本.cmd','更新番茄刻录工具到最新版.cmd']) {
  console.log((n+'                    ').slice(0,22)+':', fs.existsSync(DST+'/'+n) ? '有' : '缺失 !!');
}
const g=fs.readdirSync(DST).filter(f=>/^界面效果-1\.2\.42/.test(f));
console.log('1.2.43 效果图  :', g.length+' 张');
"
exit $RC
