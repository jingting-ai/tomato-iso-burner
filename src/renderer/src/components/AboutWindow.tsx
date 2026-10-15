import { useCallback, useEffect, useRef, useState } from 'react'
import { APP_AUTHOR, APP_BUILD_TIME, APP_CHANNEL, APP_COPYRIGHT, APP_NAME, APP_VERSION } from '@shared/version'
import { GITHUB_REPO_URL } from '@shared/links'
import type { AboutSection } from '@shared/api'
import { api } from '../lib'
import appLogo from '../assets/app-logo.png'
import donateWechat from '../assets/donate-wechat.png'
import donateAlipay from '../assets/donate-alipay.png'

interface Props {
  /** 打开后停在哪一节：'donate' 直接落到收款码 */
  section: AboutSection
}

/** 一张收款码：点一下可以放大到能直接扫 */
interface QrCard {
  key: 'wechat' | 'alipay'
  label: string
  sub: string
  src: string
}

const QR_CARDS: QrCard[] = [
  { key: 'wechat', label: '微信', sub: '微信扫一扫', src: donateWechat },
  { key: 'alipay', label: '支付宝', sub: '支付宝扫一扫', src: donateAlipay }
]

/* ------------------------------- 小图标 ------------------------------- */

function Icon({ d, extra }: { d: string; extra?: string }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d={d} fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
      {extra && <path d={extra} fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />}
    </svg>
  )
}

/** GitHub 标记（实心，和其它线性小图标区分开，链接旁边用） */
function GitHubMark() {
  return (
    <svg className="oss-mark" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path
        fill="currentColor"
        d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A7.995 7.995 0 0 0 16 8c0-4.42-3.58-8-8-8Z"
      />
    </svg>
  )
}

/** 功能一览：每条一句，只讲「能干什么」 */
const FEATURES: { icon: string; extra?: string; title: string; desc: string }[] = [
  {
    icon: 'M12 3v10m0 0 4-4m-4 4-4-4M4 17v2a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-2',
    title: '整盘镜像刻录',
    desc: '与 Rufus 的 DD 模式一致，从第 0 字节起逐字节原样写入，ISO / IMG 通吃'
  },
  {
    icon: 'M11 4.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13Z',
    extra: 'M15.8 15.8 20 20M8.2 11h5.6',
    title: '镜像内容识别',
    desc: '打开镜像就读出系统名、版本号、架构与引导方式，还能分辨 22H2 与 24H2'
  },
  {
    icon: 'M4 7c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3Zm0 0v10c0 1.7 3.6 3 8 3s8-1.3 8-3V7',
    extra: 'M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3',
    title: '非可引导格式化',
    desc: '把 U 盘还原成 FAT32 / NTFS / exFAT 空盘，分区表可选 MBR 或 GPT'
  },
  {
    icon: 'M4.5 12.5 9 17l10.5-10.5',
    extra: 'M7 4h10a3 3 0 0 1 3 3v10a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3V7a3 3 0 0 1 3-3Z',
    title: '写完即校验',
    desc: '回读整盘与源镜像逐字节比对，并给出 SHA256，数据对不对一目了然'
  },
  {
    icon: 'M12 3.5 5 6.2v5.3c0 4.2 2.9 7.6 7 9 4.1-1.4 7-4.8 7-9V6.2L12 3.5Z',
    extra: 'M9 12l2.2 2.2L15.2 10',
    title: '写盘安全保护',
    desc: '自动识别并拦下系统盘；写到内置硬盘前会弹窗强提醒，二次确认后才允许选择'
  },
  {
    icon: 'M9.5 14.5 5 19m4.5-4.5-2.2-2.2M14.5 9.5 19 5m-4.5 4.5 2.2 2.2',
    extra: 'M15.5 8.5a3.5 3.5 0 1 0-5 5l1.2 1.2 1.3-1.3 1.2 1.2 1.3-1.3 1.3 1.3 1.2-1.2-1.2-1.2 1.2-1.3-1.2-1.2Z',
    title: 'U 盘一键修复',
    desc: '分区表损坏、幽灵卷、容量显示异常，插上就能救回可用状态'
  },
  {
    icon: 'M4 5h16v11H4z',
    extra: 'M8 20h8M12 16v4',
    title: '中文错误提示',
    desc: '出错时告诉你发生了什么、下一步该怎么做，而不是丢一个 error code'
  },
  {
    icon: 'M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17Z',
    extra: 'M12 3.5v17',
    title: '双主题',
    desc: '浅色 / 深色随系统切换，夜里不刺眼，白天看得清'
  }
]

/* ------------------------------- 主体 ------------------------------- */

/**
 * 「关于 / 捐赠」——**一个独立的窗口**，不是叠在主界面上的弹层。
 *
 * 2026-10-14 用户原话：「关于这个框，如果不好做，实在不行就做成单独独立的框吧，
 * 要不然一点关于，上面就很不协调」。
 *
 * 做成独立窗口之后：
 *  · 主界面顶栏不再被任何遮罩压住，右上角那块系统叠画的窗口按钮也不用跟着换色；
 *  · 二维码放大层的 `position: fixed` 终于能按窗口定位了 —— 以前它的祖先
 *    `.modal-mask` 带 `backdrop-filter`，而带 backdrop-filter 的元素会成为
 *    固定定位的包含块，放大图实际是相对遮罩的内边距盒子定位的，整体偏低。
 */
export default function AboutWindow({ section }: Props) {
  const [zoom, setZoom] = useState<QrCard | null>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const donateRef = useRef<HTMLElement>(null)

  /** 关闭 = 关掉这个窗口（不是把某个弹层藏起来） */
  const closeWin = useCallback(() => {
    setZoom(null)
    try {
      api.closeAbout()
    } catch {
      // 主进程没接上（例如单独用浏览器打开这个页面）：什么都不做即可
    }
  }, [])

  /** 滚到某一节。'donate' → 收款码；'about' → 回到顶部 */
  const goto = useCallback((s: AboutSection) => {
    const box = bodyRef.current
    if (!box) return
    if (s === 'donate' && donateRef.current) {
      // 用 offsetTop 而不是 scrollIntoView：后者会把外层窗口也带着滚，
      // 而这里要滚的只是内容区那一个盒子。
      box.scrollTo({ top: donateRef.current.offsetTop - 8, behavior: 'smooth' })
    } else {
      box.scrollTo({ top: 0, behavior: 'smooth' })
    }
  }, [])

  // ESC 逐层退出：先收放大图，再关窗口
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      setZoom((z) => {
        if (z) return null
        closeWin()
        return null
      })
    }
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('keydown', onKey, true)
    }
  }, [closeWin])

  // 二维码放大层的遮罩会盖到右上角那块系统叠画的窗口按钮 —— 它是独立图层，
  // 网页压不到，得让主进程把那一块也跟着换色（与主窗口弹窗同一套机制，
  // 但走的是本窗口专属通道，不波及主窗口）。
  useEffect(() => {
    try {
      api.setOverlayMaskedAbout(zoom !== null)
    } catch {
      // 换色失败不影响浮层本身
    }
  }, [zoom])

  // 打开时停在指定小节。等一帧再滚 —— 内容还没排版完时 offsetTop 是 0，
  // 直接滚会原地不动（看起来就像「点了捐赠没反应」）。
  useEffect(() => {
    const t = window.setTimeout(() => goto(section), 60)
    return () => window.clearTimeout(t)
  }, [section, goto])

  // 窗口已经开着、用户又从主界面点了「捐赠」/「关于」：主进程把目标小节转发过来
  useEffect(() => {
    try {
      return api.onAboutGoto(goto)
    } catch {
      return undefined
    }
  }, [goto])

  return (
    <div className="about about-win">
      {/* 这一整条就是「合并标题栏」：系统把窗口按钮叠画在它右侧，
          整条可拖动（双击 = 最大化/还原），与主界面的顶栏同一套做法 */}
      <header className="about-head">
        <img className="about-logo" src={appLogo} alt="" draggable={false} />
        <div className="about-title">
          <div className="about-name">
            {APP_NAME}
            <span className="about-ver">v{APP_VERSION}</span>
            {APP_CHANNEL && <span className="about-beta">{APP_CHANNEL}</span>}
          </div>
          {/* 与顶栏副标题保持同一句 —— 两处各说各的会显得像两个产品 */}
          <div className="about-sub">开源免费 · 本地离线 · 把镜像写入 U 盘</div>
        </div>
        {/* 不再放页面内的关闭按钮：右上角那颗系统窗口按钮就是关闭 ——
            和主界面保持同一种语言 */}
      </header>

      <div className="about-body" ref={bodyRef}>
        {/* ---------- 免费承诺 ---------- */}
        <section className="about-hero">
          <div className="about-hero-tag">完全免费</div>
          <h3>这个工具，会一直免费下去</h3>
          <p>
            没有广告，没有内购，没有会员，没有「免费试用 30 天」，也没有藏在角落里的激活码。
            你不用注册账号，不用登录，不用联网 —— 插上 U 盘，选好镜像，点一下，它就安安静静把活干完。
          </p>
          <p>
            写它的原因很简单：市面上那些刻录软件，要么塞满捆绑，要么偏偏在你装系统、最着急的那一刻
            弹出「升级到专业版」。装个系统本来就不该这么累。
          </p>
          <p>
            所以它就这样一直免费下去。用得顺手，就是对我最好的回报；
            如果它真的帮你省下了几分钟，愿意请我喝杯咖啡，那是心意，我很感激；
            不请，它也照样好好用，一个字都不会少。
          </p>
          <div className="about-sign">—— {APP_AUTHOR}</div>
        </section>

        {/* ---------- 功能一览 ---------- */}
        <section className="about-sec">
          <h4 className="about-sec-title">
            <span className="about-sec-bar" />
            它能做什么
          </h4>
          <div className="feat-grid">
            {FEATURES.map((f) => (
              <div className="feat" key={f.title}>
                <span className="feat-icon">
                  <Icon d={f.icon} extra={f.extra} />
                </span>
                <div className="feat-text">
                  <div className="feat-title">{f.title}</div>
                  <div className="feat-desc">{f.desc}</div>
                </div>
              </div>
            ))}
          </div>
        </section>

        {/* ---------- 开源 ---------- */}
        <section className="about-sec">
          <h4 className="about-sec-title">
            <span className="about-sec-bar" />
            开源
          </h4>
          <p className="oss-lead">
            这个工具的代码是公开的 —— 任何人都可以查看、编译、修改。
            一个要往你 U 盘里写数据的软件，理应经得起所有人审视：没有暗桩，不上传任何数据。
          </p>
          {GITHUB_REPO_URL ? (
            <a className="oss-link" href={GITHUB_REPO_URL} target="_blank" rel="noreferrer">
              <GitHubMark />
              在 GitHub 上查看源码
            </a>
          ) : (
            <span className="oss-link oss-link-pending">仓库地址即将公布</span>
          )}
          <p className="oss-note">基于 MIT 许可证开源 · 欢迎 Star、提 Issue、贡献代码</p>
        </section>

        {/* ---------- 捐赠 ---------- */}
        <section className="about-sec" ref={donateRef}>
          <h4 className="about-sec-title">
            <span className="about-sec-bar" />
            请作者喝杯咖啡
          </h4>
          <p className="donate-lead">
            工具不收钱，也不打算收钱。你要是觉得它好用，可以扫码支持一下 ——
            金额随意，心意更重。收到的每一份，我都记着。
          </p>
          <div className="donate-grid">
            {QR_CARDS.map((c) => (
              <figure className={`qr-card ${c.key}`} key={c.key}>
                <figcaption className="qr-title">
                  <span className="qr-dot" />
                  {c.label}
                </figcaption>
                <button className="qr-shot" onClick={() => setZoom(c)} title="点击放大">
                  <img src={c.src} alt={`${c.label}收款二维码`} draggable={false} />
                  <span className="qr-zoom">点击放大</span>
                </button>
                <div className="qr-foot">{c.sub}</div>
              </figure>
            ))}
          </div>
          <p className="donate-note">
            二维码只用于个人转账，扫码前请核对金额与收款人；本工具不会读取、存储或上传任何支付信息。
          </p>
        </section>
      </div>

      <footer className="about-foot">
        <span>{APP_COPYRIGHT}</span>
        <span className="about-sep">·</span>
        <span>构建于 {APP_BUILD_TIME}</span>
      </footer>

      {/* ---------- 二维码放大 ---------- */}
      {zoom && (
        <div className="qr-zoom-mask" onClick={() => setZoom(null)} role="presentation">
          <div className="qr-zoom-box" onClick={(e) => e.stopPropagation()}>
            <img src={zoom.src} alt={`${zoom.label}收款二维码`} draggable={false} />
            <div className="qr-zoom-hint">{zoom.sub}</div>
          </div>
        </div>
      )}
    </div>
  )
}
