# ---------------------------------------------------------------------------
# 自定义安装器行为
#   electron-builder 打包时会自动引入 build/installer.nsh（见 nsis.include / 默认约定）
#
# 为什么需要这个文件：
#   electron-builder 生成的 NSIS 安装包**没有** MSI 那种「修改 / 修复 / 删除」维护界面。
#   检测到已安装时，它只会静默执行：
#       Uninstall ...exe /S /KEEP_APP_DATA --updated /allusers
#   卸载掉旧版本，再直接铺新文件 —— 全程不给任何提示。
#   带来的实际后果：
#     ① 双击安装包看起来"没反应"，或者很快就结束了，不知道装了什么版本；
#     ② 重复运行同一个旧安装包，文件被原样覆盖，用户却以为"已经升级了"。
#
# 这里在 .onInit 阶段（**任何文件被改动之前**）补一个明确的确认页：
#   1. 显示本机当前已安装的版本；
#   2. 显示本次要安装的版本；
#   3. 版本相同时明确警告"你可能运行的是同一个旧安装包"。
# ---------------------------------------------------------------------------

!macro customInit
  # --- 读取本机已安装版本（所有用户装在 HKLM，仅当前用户装在 HKCU）---
  StrCpy $R0 ""
  ReadRegStr $R0 HKEY_LOCAL_MACHINE "${UNINSTALL_REGISTRY_KEY}" "DisplayVersion"
  ${If} $R0 == ""
    ReadRegStr $R0 HKEY_CURRENT_USER "${UNINSTALL_REGISTRY_KEY}" "DisplayVersion"
  ${EndIf}

  ${If} $R0 == ""
    # ================= 全新安装：直接装，不弹确认框 =================
    # 用户 2026-10-15：第一次安装不需要弹确认框，只有本机已经装过才开始弹。
    Goto tomatoInitGo
  ${ElseIf} $R0 == "${VERSION}"
    # ========= 版本完全相同：正是「重复运行同一个安装包」的情况 =========
    MessageBox MB_OKCANCEL|MB_ICONEXCLAMATION|MB_TOPMOST "本机已安装的版本就是 v$R0，与本次要安装的版本完全相同。$\r$\n$\r$\n继续安装只会用同一份文件覆盖一遍，结果不会有任何变化。$\r$\n$\r$\n如果你本来是想用新版本，请点「取消」退出，改用版本号更大的安装包，或直接使用免安装的绿色版（解压后双击 exe，标题栏会显示实际版本号）。$\r$\n$\r$\n仍要继续吗？" IDOK tomatoInitGo
    Abort
  ${Else}
    # ================= 升级 / 降级 =================
    MessageBox MB_OKCANCEL|MB_ICONINFORMATION|MB_TOPMOST "检测到本机已安装 番茄镜像刻录工具 v$R0。$\r$\n$\r$\n本次要安装的版本：v${VERSION}$\r$\n安装位置：$INSTDIR$\r$\n$\r$\n安装程序会先卸载旧版本，再安装新版本；你的设置与刻录日志会被保留。$\r$\n$\r$\n点击「确定」开始安装。" IDOK tomatoInitGo
    Abort
  ${EndIf}

  tomatoInitGo:
!macroend
