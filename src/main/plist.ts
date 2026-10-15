/**
 * 极简 Apple XML plist 解析器（仅支持 dict / array / string / integer / real / true|false / data）。
 * 用于解析 `diskutil ... -plist` 的输出，避免引入额外依赖。
 */
export function parsePlist(xml: string): any {
  const src = xml.replace(/<\?xml[\s\S]*?\?>/g, '').replace(/<!DOCTYPE[\s\S]*?>/g, '')
  let pos = 0

  const ws = (): void => {
    while (pos < src.length && /\s/.test(src[pos])) pos++
  }

  const expect = (s: string): void => {
    ws()
    if (!src.startsWith(s, pos)) throw new Error(`plist: expected "${s}" at ${pos}`)
    pos += s.length
  }

  const readTag = (): { closing: boolean; name: string; self: boolean } => {
    ws()
    expect('<')
    let closing = false
    if (src[pos] === '/') {
      closing = true
      pos++
    }
    let name = ''
    while (pos < src.length && /[^\s/>]/.test(src[pos])) name += src[pos++]

    // 跳过标签内的属性（如 <plist version="1.0">）
    let quote: string | null = null
    let end = pos
    while (end < src.length) {
      const c = src[end]
      if (quote) {
        if (c === quote) quote = null
      } else if (c === '"' || c === "'") {
        quote = c
      } else if (c === '>') {
        break
      }
      end++
    }
    const self = end > 0 && src[end - 1] === '/'
    pos = end
    expect('>')
    return { closing, name, self }
  }

  const readText = (): string => {
    ws()
    let t = ''
    while (pos < src.length && src[pos] !== '<') t += src[pos++]
    return decodeEntities(t)
  }

  const simple = (): string => {
    readTag()
    const t = readText()
    readTag()
    return t
  }

  const value = (): any => {
    ws()
    // 预读标签名
    const save = pos
    ws()
    expect('<')
    if (src[pos] === '/') pos++
    let name = ''
    while (pos < src.length && /[^\s/>]/.test(src[pos])) name += src[pos++]
    pos = save

    switch (name) {
      case 'dict':
        return dict()
      case 'array':
        return array()
      case 'string':
      case 'key':
      case 'data':
      case 'date':
        return simple()
      case 'integer': {
        const s = simple()
        const n = Number.parseInt(s.trim(), 10)
        return Number.isNaN(n) ? 0 : n
      }
      case 'real': {
        const s = simple()
        const n = Number.parseFloat(s)
        return Number.isNaN(n) ? 0 : n
      }
      case 'true':
        readTag()
        return true
      case 'false':
        readTag()
        return false
      default:
        throw new Error(`plist: unsupported tag <${name}>`)
    }
  }

  const dict = (): Record<string, any> => {
    readTag()
    const o: Record<string, any> = {}
    for (;;) {
      ws()
      if (src.startsWith('</dict', pos)) {
        readTag()
        return o
      }
      const k = simple()
      o[k] = value()
    }
  }

  const array = (): any[] => {
    readTag()
    const a: any[] = []
    for (;;) {
      ws()
      if (src.startsWith('</array', pos)) {
        readTag()
        return a
      }
      a.push(value())
    }
  }

  ws()
  readTag() // <plist ...>
  const root = value()
  readTag() // </plist>
  return root
}

function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number.parseInt(d, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(Number.parseInt(h, 16)))
    .replace(/&amp;/g, '&')
}
