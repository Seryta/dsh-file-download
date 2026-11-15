# dsh-file-download

在 DeepSeek Harness Web 的右侧预览面板里，**直接下载当前文件**——补上「能看、但下不下来」的缺口。

| 入口 | 位置 |
|---|---|
| 下载图标 | 预览标题栏，文件路径右侧、面板自带控件（换行 / 自动刷新 / 重新读取）之后 |
| 「下载文件」按钮 | 无法预览的空状态里，与原有「打开」并排 |

两个入口只要面板拿到了宿主上的真实路径就会出现：文本、图片、PDF 能下，`.apk`、`.zip`、`.ipa`、`.deb` 这类无法渲染的二进制包也能下。

## 为什么需要它

DSH 官方的 `/api/file` 路由有两个限制，对安装包这类大文件不友好：

- 它是**先读完整文件再回应**，上限取宿主的图片字节上限（默认 50 MiB），超过直接 `413`；
- 它不带 `Content-Disposition`，也没有 `ETag`，浏览器只能靠 MIME 猜行为，**中断后无法校验续传**。

官方右键菜单里其实有「下载」（`ui-file-actions` 注册的 `file` 右键菜单），但没有人会想到去右键一个文件路径。

本插件补的是一条**流式、无上限、可续传**的下载路径，并把入口放到一眼可见的位置。

## 下载链路

```
点击（同步，无 await）
  → <a download> 指向 GET /api/file-download?path=<绝对路径>
  → 浏览器/系统下载管理器接管：进度条、暂停、断点续传都在系统侧
```

宿主半部的路由：

| 方面 | 行为 |
|---|---|
| 响应头 | `Content-Disposition: attachment`（中文名带 RFC 5987）、`Content-Length`、按后缀给的媒体类型（`.apk` → `application/vnd.android.package-archive`）、`Accept-Ranges: bytes`、`ETag`、`X-Accel-Buffering: no` |
| 正文 | `ReadableStream`，按 **4 MiB 窗口**通过宿主文件系统读取并回压输出；宿主内存不随文件大小增长，没有单文件上限 |
| 范围 | `Range` → `206` + `Content-Range`；后缀区间（`bytes=-N`）支持；不可满足 → `416` |
| 续传校验 | 每个文件版本一个强 `ETag`；`If-Range` 一致才发剩余字节，**不一致退回 `200` 发整份**，避免拼出坏文件 |
| 失败 | 400（路径非法）/ 403（非普通文件或权限）/ 404（不存在）/ 416（范围不可满足） |

客户端在页面加载时用一次 `HEAD` 探测这条路由：存在就用它，缺失（例如宿主半部还没加载）则退回官方 `/api/file`，不会因此报错。

## 反向代理

路由自带 `X-Accel-Buffering: no`，nginx 会据此关掉该响应的缓冲，所以代理层不是必须改配置。若想整站更稳，建议（`nginx` 为例）：

```nginx
proxy_buffering off;            # 默认 on 时大文件会被代理缓冲，超 proxy_buffers 就落盘临时文件
proxy_max_temp_file_size 0;     # 兜底
proxy_read_timeout 3600s;       # 手机锁屏/切后台导致上游停顿，默认 60s 会被掐断
proxy_send_timeout 3600s;       # 慢客户端侧同理
```

`Range` 默认透传，`Content-Disposition` 不在默认 `proxy_hide_header` 名单里，两者都不需要额外处理；二进制类型不在常见 `gzip_types` 中，也不会被压缩。

## 安装

作为本地 bundle 安装（包目录即本仓库）：

```bash
dsh plugin --profile <profile> add <本仓库绝对路径>
```

或在 DSH 里用 Plugin Manager 安装该目录。装完 **刷新页面**（客户端模块会热更新，路由需要宿主重启才注册）。

## 验证

```bash
npm test        # node test/route.test.mjs
```

`test/route.test.mjs` 是宿主路由的契约测试：用真实文件字节 + 一个文件系统形状的假件驱动注册出来的 handler，覆盖

- 完整文件按 4 MiB 窗口流式输出、`Content-Length`/媒体类型/`Content-Disposition` 正确、md5 一致；
- `HEAD` 不读盘；`Range` 首段 / 后缀段 / 不可满足（`416`）；
- 路径校验（空 / 相对 / 含 NUL）与 `FsError` 码到 HTTP 状态的映射；
- 中文文件名的 ASCII 兜底 + RFC 5987 形式；
- 客户端断开后流能收敛、不悬挂；
- **续传**：`ETag` 有引号/单行/跨请求稳定/随版本变化；`If-Range` 匹配 → `206` 且字节数 = 总量 − 偏移、md5 与源文件尾段一致；`If-Range` 陈旧 → `200` 整份一致；两段拼接（先 `0-1048575`，再带 `If-Range` 取剩余）拼回 md5 与源文件一致。

本机回环实测（100 MiB 文件，dsh 0.2.2-rc.3 + 本机 nginx→gate→web 链路）：

| 场景 | 结果 |
|---|---|
| 完整下载 | `200`、104,857,600 B、0.65s、md5 与源一致 |
| 续传 `Range: bytes=1048576-` + 匹配 `If-Range` | `206`、103,809,024 B、md5 与源文件尾段一致 |
| 陈旧 `If-Range` | `200`、整份 104,857,600 B、md5 一致 |
| 经反向代理与鉴权网关的续传 | `206`、字节与 md5 同上 |

未被覆盖的边界：浏览器下载管理器的「暂停/继续」按钮没有做端到端点击验证（CDP 无法可靠模拟中断后恢复），验证的是它依赖的服务端契约——浏览器续传时发的正是上文那组请求。

## 目录结构

```
index.js           宿主半部：/api/file-download 流式路由（窗口读取、Range、ETag/If-Range）
client.js          客户端半部：两个 Slot 入口 + 同步触发下载 + 路由探测
cordis.patch.yml   bundle 装配：插入 file-download 行
locale/            Plugin Manager 显示元数据（中/英）
docs/DETAIL.md     插件详情页文档
icon.svg           插件图标
test/route.test.mjs  宿主路由契约测试（npm test）
```

## 已知边界

- 只面向 Web（`dsh.client.platform: web`）；桌面端的「另存为」仍由官方 `ui-file-actions` 负责。
- 下载文件名取宿主路径最后一段；同名文件由浏览器自行加序号。
- 宿主重启后需要刷新页面，已打开的页面才会重新探测到流式路由。
- 旧浏览器不支持 `If-Range` 时会重下整份；不影响正确性。

## License

MIT © 2026 Saryta
