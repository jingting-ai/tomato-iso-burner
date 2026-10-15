// 本文件由 tools/version.cjs 自动生成，请勿手动修改。
// 每次功能改进后执行构建/打包，版本号会自动递增（详见 README「版本管理」）。

/** 应用名称 */
export const APP_NAME = '番茄镜像刻录工具'
/** 开发者 */
export const APP_AUTHOR = '敬亭'
/** 版本号（语义化版本 major.minor.patch） */
export const APP_VERSION = '1.2.54'
/** 构建号：YYYYMMDD.HHMM */
export const APP_BUILD = '20261015.1020'
/** 构建时间（本地时间） */
export const APP_BUILD_TIME = '2026-10-15 10:20:20'
/** 版权信息 */
export const APP_COPYRIGHT = 'Copyright © 2026 敬亭'
/** 发布渠道：Alpha / Beta / RC；正式版为空字符串 */
export const APP_CHANNEL = 'Beta'
/** 带渠道的版本标签，例如「v1.0.1 Beta」；正式版就是「v1.0.1」 */
export function versionLabel(): string {
  return `v${APP_VERSION}${APP_CHANNEL ? ` ${APP_CHANNEL}` : ''}`
}

/** 带版本号的窗口标题，例如「番茄镜像刻录工具 v1.0.1 Beta」 */
export function appTitle(): string {
  return `${APP_NAME} ${versionLabel()}`
}

/** 底部展示的署名，例如「由敬亭开发 · v1.0.1」 */
export function appCredit(): string {
  return `由 ${APP_AUTHOR} 开发 · ${versionLabel()}`
}
