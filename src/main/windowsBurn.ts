/**
 * Windows 原生写盘：调用 assets/burn.ps1（Win32 API + .NET FileStream）。
 *
 * 为什么不用 Node 的 fs 直接写 \\.\PhysicalDriveN：
 *  - Node 在 Windows 原始设备路径上存在 EINVAL / 路径被改写等坑；
 *  - Node 的 fs 无法执行 FSCTL_LOCK_VOLUME，导致写入只成功 MBR、其余扇区 EPERM。
 *
 * 策略（保守）：
 *  - 只使用 \\.\PhysicalDriveN 物理磁盘路径写入整盘镜像；
 *  - 绝不回退到 \\.\X: 卷路径，避免只破坏文件系统而遗留坏分区表；
 *  - 进度 / 错误 / 完成 全部通过 -LogFile 的 JSONL 文件传递，避免 PowerShell stdout 编码问题。
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { WriteOptions } from '@shared/types'
import { powershellPath } from './exec'

/** 写盘日志目录：持久保存，便于失败后排查（不再用完即删） */
function logDir(): string {
  const base = process.env.LOCALAPPDATA || os.tmpdir()
  const dir = path.join(base, 'TomatoIsoBurner', 'logs')
  try {
    fs.mkdirSync(dir, { recursive: true })
  } catch {
    return os.tmpdir()
  }
  return dir
}

export interface WindowsBurnHooks {
  onLog: (text: string, level: 'info' | 'warn' | 'error' | 'success') => void
  onTick: (s: {
    phase: 'write' | 'verify'
    percent: number
    writtenBytes: number
    totalBytes: number
    speed: number
    etaSeconds: number
  }) => void
  isCancelled: () => boolean
}

export interface WindowsBurnResult {
  sourceSha256: string
  verifySha256: string
  bytesWritten: number
}

function resolveBurnScript(): string {
  const candidates = [
    path.join(process.resourcesPath || '', 'burn.ps1'),
    path.join(__dirname, '..', '..', 'assets', 'burn.ps1'),
    path.join(__dirname, '..', 'assets', 'burn.ps1'),
    path.resolve(process.cwd(), 'assets', 'burn.ps1')
  ]
  for (const c of candidates) {
    try {
      if (c && fs.existsSync(c)) return c
    } catch {
      /* ignore */
    }
  }
  throw new Error('找不到 burn.ps1 写盘脚本，请确认安装完整')
}

export async function runWindowsBurn(
  opts: WriteOptions,
  hooks: WindowsBurnHooks
): Promise<WindowsBurnResult> {
  const script = resolveBurnScript()
  const flagFile = path.join(os.tmpdir(), `tomato-cancel-${process.pid}-${Date.now()}.flag`)
  const logFile = path.join(logDir(), 'burn-latest.jsonl')
  const imageSize = fs.statSync(opts.imagePath).size
  try {
    fs.unlinkSync(logFile)
  } catch {
    /* 首次运行或文件不存在 */
  }

  const args = [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    script,
    '-ImagePath',
    opts.imagePath,
    '-DevicePath',
    opts.device.devicePath,
    '-LogFile',
    logFile,
    '-TotalBytes',
    String(imageSize),
    '-ChunkSize',
    '1048576',
    '-CancelFlag',
    flagFile
  ]
  if (opts.validate) args.push('-Verify')
  // 整盘镜像写入时清空旧分区表（镜像自带新的分区表），
  // 这样即使目标盘分区表损坏也能被覆盖，避免“写入 offset 0 失败”。
  if (opts.wipeBeforeWrite) args.push('-Wipe')

  hooks.onLog(`启动原生写盘脚本：${script}`, 'info')
  hooks.onLog(`目标物理磁盘：${opts.device.devicePath}`, 'info')
  hooks.onLog(`本次写盘日志（失败时请把这个文件发给开发者）：${logFile}`, 'info')

  return await new Promise<WindowsBurnResult>((resolve, reject) => {
    const child = spawn(powershellPath(), args, { windowsHide: true })
    let result: WindowsBurnResult | null = null
    let errorMsg = ''
    /** 已消费的字符数（按「完整行」推进，避免把写了一半的行吃掉） */
    let consumed = 0
    /** 日志里出现过的最后一条 error 文本（兜底用） */
    let lastErrorText = ''

    const cancelTimer = setInterval(() => {
      if (hooks.isCancelled() && !fs.existsSync(flagFile)) {
        try {
          fs.writeFileSync(flagFile, 'cancel')
        } catch {
          /* ignore */
        }
      }
    }, 200)

    const cleanup = () => {
      clearInterval(cancelTimer)
      try { fs.unlinkSync(flagFile) } catch { }
      // 注意：写盘日志刻意保留，方便失败后排查
    }

    const finish = (fn: () => void) => {
      cleanup()
      fn()
    }

    // 解析单行日志
    function handleLine(line: string) {
      const clean = line.replace(/^\uFEFF/, '').trim()
      if (!clean) return
      let msg: any
      try {
        msg = JSON.parse(clean)
      } catch {
        // 非 JSON 行忽略（安全冗余）
        return
      }
      if (msg.type === 'progress') {
        hooks.onTick({
          phase: msg.phase,
          percent: Number(msg.percent) || 0,
          writtenBytes: Number(msg.written) || 0,
          totalBytes: Number(msg.total) || 0,
          speed: Number(msg.speed) || 0,
          etaSeconds: typeof msg.eta === 'number' ? msg.eta : -1
        })
      } else if (msg.type === 'info') {
        hooks.onLog(String(msg.message || ''), 'info')
      } else if (msg.type === 'warn') {
        hooks.onLog(String(msg.message || ''), 'warn')
        lastErrorText = String(msg.message || '')
      } else if (msg.type === 'error') {
        errorMsg = String(msg.message || '未知错误')
        lastErrorText = errorMsg
        hooks.onLog(errorMsg, 'error')
      } else if (msg.type === 'done') {
        result = {
          sourceSha256: msg.sourceSha256 || '',
          verifySha256: msg.verifySha256 || '',
          bytesWritten: Number(msg.written) || imageSize
        }
      }
    }

    /**
     * 增量读取 JSONL 日志。
     * ⚠️ 只消费「以换行结尾」的完整行：日志是被逐行追加写入的，
     *    轮询时最后一行很可能只写了一半，直接解析会失败并被永久跳过，
     *    结果就是界面上看不到真正的错误原因（只显示“进程异常退出”）。
     */
    function consumeLog() {
      let text: string
      try {
        if (!fs.existsSync(logFile)) return
        text = fs.readFileSync(logFile, 'utf8')
      } catch {
        return // 文件可能正在写入
      }
      if (text.length < consumed) consumed = 0 // 日志被重建过
      const chunk = text.slice(consumed)
      if (!chunk) return
      const lastNl = chunk.lastIndexOf('\n')
      if (lastNl < 0) return // 还没有完整的一行
      const usable = chunk.slice(0, lastNl + 1)
      consumed += usable.length
      for (const ln of usable.split('\n')) handleLine(ln)
    }

    const pollTimer = setInterval(consumeLog, 150)

    child.stdout?.on('data', (d: Buffer) => {
      const t = d.toString('utf8').trim()
      if (t) hooks.onLog(`[ps] ${t}`, 'info')
    })

    child.stderr?.on('data', (d: Buffer) => {
      const t = d.toString('utf8').trim()
      if (t) hooks.onLog(t, 'warn')
    })

    child.on('error', (err) => {
      finish(() => reject(new Error(`无法启动 PowerShell 写盘进程：${err.message}`)))
    })

    child.on('close', (code) => {
      clearInterval(pollTimer)
      // 最后再读一次日志，确保没有遗漏
      consumeLog()
      // 进程已退出，此时日志必然是完整行；再补一次以防末尾没有换行
      try {
        if (fs.existsSync(logFile)) {
          const text = fs.readFileSync(logFile, 'utf8')
          if (text.length > consumed) {
            for (const ln of text.slice(consumed).split('\n')) handleLine(ln)
            consumed = text.length
          }
        }
      } catch { }

      finish(() => {
        if (result) resolve(result)
        else if (hooks.isCancelled()) reject(new Error('已取消刻录'))
        else {
          const base =
            errorMsg ||
            lastErrorText ||
            `写盘进程异常退出（代码 ${code}）`
          reject(new Error(`${base}\n\n完整日志：${logFile}`))
        }
      })
    })
  })
}
