import { app } from 'electron'
import { run, runPowerShell } from './exec'

export async function isElevated(): Promise<boolean> {
  if (process.platform === 'win32') {
    const r = await runPowerShell(
      'New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent()) | ForEach-Object { $_.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator) }'
    ).catch(() => ({ stdout: '', stderr: '', code: 1 }))
    return r.stdout.trim().toLowerCase() === 'true'
  }
  if (process.platform === 'darwin') {
    return typeof process.getuid === 'function' && process.getuid() === 0
  }
  return false
}

export interface ElevateResult {
  ok: boolean
  message: string
}

/**
 * 以特权重新启动本应用。
 * 仅对打包后的应用自动提升；开发模式下返回提示，避免以 root 身份运行开发服务器带来的副作用。
 */
export async function elevate(): Promise<ElevateResult> {
  /**
   * 要重启的「程序本体」。
   *
   * ⚠️ 绿色版（单文件便携版）下 process.execPath 指向的是**解包到临时目录的那份副本**，
   *    拿它去提权重启，等便携启动器一退出这份副本就被删了 —— 用户看到的是
   *    「点了以管理员重启，新窗口闪一下就没了」。所以优先用便携启动器交给我们的
   *    外层单文件路径（PORTABLE_EXECUTABLE_FILE），它才是用户手上那个 exe。
   */
  const portableExe = process.env['PORTABLE_EXECUTABLE_FILE'] || ''
  const target = portableExe || process.execPath
  const args = app.isPackaged ? ['--elevated'] : [app.getAppPath(), '--elevated']

  if (process.platform === 'win32') {
    if (!app.isPackaged) {
      return {
        ok: false,
        message: '开发模式请以管理员身份运行终端后执行 npm run dev'
      }
    }
    const argList = args.map((a) => `"${a.replace(/"/g, '\\"')}"`).join(',')
    const ps = `Start-Process -FilePath "${target}" -ArgumentList @(${argList}) -Verb RunAs`

    // 必须在启动新实例【之前】让出单实例锁：新实例启动时要抢这把锁，
    // 若此时还握在手里，新实例会被判定为「已有实例在运行」而立即退出，
    // 用户看到的现象就是点了「以管理员重启」后什么都没发生。
    app.releaseSingleInstanceLock()

    const r = await runPowerShell(ps, 20000)
    if (r.code !== 0 && r.stderr.trim()) {
      // 用户在 UAC 弹窗点了「否」，或提升被系统拒绝：把锁收回来，避免本进程变成可多开
      app.requestSingleInstanceLock()
      return { ok: false, message: `提升失败：${r.stderr.trim()}` }
    }
    return { ok: true, message: '已请求以管理员身份重新启动，请在 UAC 弹窗中确认' }
  }

  if (process.platform === 'darwin') {
    const cmd = [target, ...args].map((a) => `'${a.replace(/'/g, "'\\''")}'`).join(' ')
    const script = `do shell script "nohup ${cmd} >/dev/null 2>&1 &" with administrator privileges`
    // 同 Windows：新实例启动前必须让出单实例锁
    app.releaseSingleInstanceLock()
    const r = await run('osascript', ['-e', script], 60000)
    if (r.code !== 0) {
      app.requestSingleInstanceLock()
      return { ok: false, message: r.stderr.trim() || '提升失败或被用户取消' }
    }
    return { ok: true, message: '已请求以管理员身份重新启动，请在系统弹窗中输入密码' }
  }

  return { ok: false, message: '当前平台不支持自动提升，请使用 sudo 运行' }
}
