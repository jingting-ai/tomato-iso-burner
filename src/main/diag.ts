import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs'
import path from 'node:path'
import { app } from 'electron'

/**
 * 启动自述日志。
 *
 * 为什么需要它：应用是「先隐藏、等首帧画好再显示」的窗口（show:false +
 * ready-to-show）。这条路一旦在用户机器上断掉，表现出来就是
 * 「双击图标、任务管理器里有进程、但窗口一直不出现」—— 用户只能看到
 * 「打不开」，而我们这边任何界面内的日志都拿不到（界面根本没显示）。
 *
 * 所以把启动过程写到磁盘：窗口创建、各条显示路径谁先到、页面加载失败、
 * 渲染进程崩溃、渲染层的报错，全部落到 `%APPDATA%\<应用名>\startup.log`。
 * 出问题时把这个文件拿出来就能直接定位，不用再猜。
 *
 * 两种落盘模式（由 diagInit 传入）：
 *   'file'     安装版。每一条都实时追加，长期使用也能追溯。
 *   'deferred' 绿色版（单文件便携版）。**平时一个日志文件都不产生**，
 *              先攒在内存里；只有出现「!! 开头」的异常记录时才整段落盘。
 *              这样用户拿到的就是「干干净净一个 exe」，真出问题时又不会
 *              两眼一抹黑。（用户原话：绿色版「也不要生成什么日志文件啥的」。）
 */

type DiagMode = 'file' | 'deferred'

let logPath = ''
let mode: DiagMode = 'file'
/** deferred 模式下攒在内存里的行 */
const pending: string[] = []
/** deferred 模式的缓冲上限，防止长期运行把内存吃光 */
const MAX_PENDING = 500
/** 超过这个大小就轮转一份，避免长期使用把磁盘写满 */
const MAX_BYTES = 512 * 1024

/** 判断一条记录算不算「异常」—— 异常就立刻把缓冲区刷到磁盘 */
function isProblem(msg: string): boolean {
  return msg.startsWith('!!')
}

export function diagInit(fileMode: DiagMode = 'file'): void {
  mode = fileMode
  try {
    const dir = app.getPath('userData')
    mkdirSync(dir, { recursive: true })
    logPath = path.join(dir, 'startup.log')
    try {
      if (statSync(logPath).size > MAX_BYTES) {
        renameSync(logPath, path.join(dir, 'startup.previous.log'))
      }
    } catch {
      // 文件还不存在：第一次运行，正常
    }
  } catch {
    // userData 取不到（极罕见）就只写标准输出，不影响启动
    logPath = ''
  }
}

export function diagPath(): string {
  return logPath
}

function write(line: string): void {
  if (!logPath) return
  try {
    appendFileSync(logPath, line, 'utf8')
  } catch {
    // 磁盘只读 / 被占用：日志失败绝不能影响应用本身
  }
}

/** 把 deferred 模式攒下的内容一次性落盘（异常时自动调用，也可手动调） */
export function diagFlush(): void {
  if (!pending.length) return
  write(pending.join(''))
  pending.length = 0
}

export function diag(msg: string): void {
  const line = `[${new Date().toISOString()}] ${msg}\n`
  // 带控制台时也输出一份，方便命令行排查
  try {
    process.stdout.write(line)
  } catch {
    // 打包后没有控制台，忽略
  }
  if (!logPath) return

  if (mode === 'file') {
    write(line)
    return
  }

  // deferred：先攒着；一旦出现异常，连前面攒的上下文一起落盘 ——
  // 只留最后一行错误是没有排查价值的，必须带上「走到哪一步才炸的」。
  pending.push(line)
  if (pending.length > MAX_PENDING) pending.shift()
  if (isProblem(msg)) diagFlush()
}
