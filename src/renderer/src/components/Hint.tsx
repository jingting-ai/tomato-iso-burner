import { useId } from 'react'
import type { ReactNode } from 'react'

interface Props {
  /** 展开后显示的说明文字 */
  text: ReactNode
}

/**
 * 行内「?」提示：平时只占一个小小的问号，鼠标移上去（或键盘 Tab 聚焦）才弹出说明。
 *
 * 为什么要有它：写入方式下面那段解释很长（DD 模式会覆盖分区表、Windows 会提示格式化…），
 * 每次打开界面都横在那里，把「模式」这一行的重心抢走了。
 * 用户 2026-10-14 的要求是「做成问号形式的提示语，默认收纳，鼠标到了才弹出来显示」。
 *
 * 放在 <label> 里，所以点击要拦一下 —— 否则点问号会顺带把 label 的 htmlFor 目标（下拉框）点开。
 */
export default function Hint({ text }: Props) {
  const id = useId()

  return (
    <span
      className="hint"
      tabIndex={0}
      aria-label="查看说明"
      aria-describedby={id}
      onClick={(e) => {
        e.preventDefault()
        e.stopPropagation()
      }}
    >
      <span className="hint-q" aria-hidden="true">
        ?
      </span>
      <span className="hint-pop" id={id} role="tooltip">
        {text}
      </span>
    </span>
  )
}
