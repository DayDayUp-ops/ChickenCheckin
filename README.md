# 小帅博士自律打卡系统

用于 Cloudflare Pages + Pages Functions + D1 的 2.0 发布源码。发布版不内嵌任何用户记录。

- 构建命令：`npm run build`
- 输出目录：`dist-pages`
- 根目录：留空
- 框架预设：None
- D1 绑定变量名：`DB`
- 加密变量：`INVITE_CODE`、`AUTH_PEPPER`、`RECOVERY_CODE`
- 全新数据库：执行 `database/schema.sql`
- 已使用旧版数据库：仅执行一次 `database/upgrade-to-2.0.sql`

2.0 变化：

- 取消程序内的账号数量上限。
- 同步密码最少 6 位，允许使用纯数字。
- 忘记密码可用恢复码重设；重设会使其他设备的旧登录状态失效。
- 首次打开 2.0 会清空浏览器中的旧打卡记录；升级 SQL 会清空云端旧记录。

安全提示：恢复码相当于所有账号共用的重置钥匙。知道同步账号和恢复码的人可以重设该账号密码。

本仓库不包含任何用户历史日志或真实密钥。
