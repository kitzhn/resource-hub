# Resource Hub

两个计划项目共用的独立资源检索服务：云端 LunaTV 的影视接口适配，以及本地 / 自建应用的影视、磁力链和漫画分类检索。

当前版本 **0.1.0，是可运行的本地 JSON 索引原型**。提供 API、鉴权、分页、LunaTV 协议适配、容器配置和自动测试。还没有真实资源源、网页界面、自动采集、自动下载、漫画阅读器或实际媒体播放验证。

演示目录的链接全部指向保留的 `.invalid` 域名，演示磁力链使用零哈希，均不能下载或播放。标题中的 4K 也只是演示字段。

## 本地启动

使用 Node.js 24 或以上版本；无第三方运行依赖，也不需要先安装包。

1. 复制 `.env.example` 为 `.env`。
2. 生成随机令牌，填入 `.env` 的 `API_TOKEN`；保留文件在本机：

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

3. 启动：

```sh
node --env-file=.env src/server.js
```

默认地址为 `http://127.0.0.1:3001`。除了健康检查，所有数据接口默认都要求 `Authorization: Bearer <API_TOKEN>`。令牌缺失或未替换示例占位符时拒绝启动。不要把令牌放入前端源码、公开配置、URL 或 `NEXT_PUBLIC_*` 环境变量。

```sh
curl http://127.0.0.1:3001/v1/health
curl -H "Authorization: Bearer YOUR_TOKEN" "http://127.0.0.1:3001/v1/search?q=demo&kind=vod"
```

PowerShell 可使用 `Invoke-RestMethod -Headers @{Authorization="Bearer $env:API_TOKEN"} -Uri 'http://127.0.0.1:3001/v1/search?q=demo'`。这里的环境变量需要自行在当前终端设置；服务读取 `.env` 不会给其他终端注入变量。

## 接口

| GET 路径 | 用途 |
|---|---|
| `/v1/health` | 不含私有索引信息的健康检查，免认证 |
| `/v1/search?q=关键词&kind=vod&limit=20&cursor=0` | 分类搜索；kind 可省略或为 vod / torrent / comic |
| `/v1/resources/{id}` | 资源详情 |
| `/v1/resources/{id}/episodes` | 仅影视的分集 |
| `/v1/resources/{id}/chapters` | 仅漫画的章节和页地址 |
| `/compat/vod?ac=videolist&wd=关键词&pg=1` | LunaTV 风格影视搜索 |
| `/compat/vod?ac=videolist&ids=资源ID` | LunaTV 风格影视详情 |

搜索返回 `{items, total, nextCursor}`；cursor 是下一页偏移值，索引按 ID 稳定排序，服务重启并更换数据后需重新开始分页。limit 为 1–100，关键词为 1–128 个字符，按标题 / tags 匹配，不是网页全文搜索。

兼容接口返回 `{code, page, pagecount, limit, total, list}`，每页 20 项。只输出存在 HLS 分集的影视条目；不会把漫画页或磁力链伪装成播放器可用的流地址。`.m3u8` 后的查询参数会完整保留。

所有接口只读，不接收任意 URL 抓取请求，不执行网页代码，不启动下载任务。HTTP 数据响应带 `private, no-store`，没有跨域放行头；当前不适合作为浏览器直接访问的公开 API。

## 接入自己的目录

按照 `examples/catalog.demo.json` 的结构创建 `data/catalog.json`，将 `.env` 中 `CATALOG_PATH` 改为 `data/catalog.json`，然后重启。该目录及 `.env` 已从 Git 中排除；备份需自行保存。

目录版本固定为 `1`，最多 10 MiB / 10000 条资源。启动时检查重复 ID、字段类型、来源、时间、资源 URL 和类型字段；失败时不会退回演示目录。程序启动后将索引保存在内存，文件改动不会自动重载。

每条资源必须包含：

| 字段 | 规则 |
|---|---|
| id | 唯一字符串，仅字母、数字、下划线、连字符，1–80 字符 |
| kind | vod / torrent / comic |
| title | 标题 |
| sourceId / sourceUrl | 来源标识和网页地址 |
| fetchedAt | ISO 日期时间，例如 `2026-10-16T00:00:00Z` |
| rightsStatus | authorized / open-license / public-domain / unverified / demo |
| tags | 可选字符串数组，用于搜索 |

影视增加 `episodes: [{title, url}]`；可选 `poster` 和四位字符串 `year`。漫画增加 `chapters: [{title, pages: [url]}]`。所有网页、图片和播放地址只接受 HTTP(S)，禁止 URL 内嵌用户名 / 密码。影视标题与地址不能包含 LunaTV 使用的分隔符 `$`、`#`；这些字符如果出现在真实 URL 参数内，应先正确百分号编码。

磁力条目增加 `infohashV1`（40 位十六进制）和匹配的 `magnet`；可选 `sizeBytes`、`resolution`、`resolutionVerified`。首版只校验 BT v1 十六进制哈希，尚不支持 v1 Base32 / BT v2 规范化或跨源自动去重。`resolutionVerified` 只是录入数据，本程序没有探测视频分辨率；不得据此宣称已经验证 4K。

`rightsStatus` 也是目录维护者声明，不代表程序替你验证授权。演示、未核实授权的数据应保留在私有测试环境。目录中只放计划向 API 使用者披露的元数据，不放令牌、站点 Cookie 或私人文件路径。

## 接入 LunaTV

当前已审计的 LunaTV 分支只会给上游发送普通 VOD 请求，没有为源配置单独的 Bearer 请求头。因此默认安全配置下，直接填 URL 会得到 **401**，需要先建立受控的访问路径。

支持两种方式：

1. 客户端 / 适配代理在服务端带上 Bearer 令牌；代理必须独立认证和限制调用方。
2. 在独立、受控的内部网络中，为 LunaTV 设置固定 IP，将这个**实际 TCP 对端 IP**加入 `COMPAT_ALLOWED_IPS`。只为 `/compat/vod` 免认证；`/v1/*` 数据仍需令牌。留空时没有任何免认证来源。程序忽略 `X-Forwarded-For` 和 `X-Real-IP`，不支持 CIDR。

不要把共享反向代理 IP 加到白名单，否则经该代理访问的其他人也可能获得权限。本地直连测试可显式设置 `COMPAT_ALLOWED_IPS=127.0.0.1`；容器连接使用实际容器 IP，不能照抄本机回环地址。

完成网络与认证设置后，LunaTV 可使用以下源配置；域名仅在两个服务位于同一受控容器网络时可解析：

```json
{
  "api_site": {
    "resourcehub": {
      "api": "http://resource-hub:3001/compat/vod",
      "name": "Resource Hub"
    }
  }
}
```

这段配置不包含令牌，也不会由本项目自动写入现有 LunaTV 或配置仓库。

LunaTV 已审计版本 `586ab2a0588ed838aee2ab80892887a38cd4280d` 的常规搜索解析用 `endsWith('.m3u8')` 判断播放地址，会忽略带签名参数的链接。该分支需要另行修复 URL 判断后，才能完整支持本服务保留的签名 URL。本仓库没有改动 LunaTV，也没有对其线上实例做播放测试。

## Docker

复制并设置 `.env` 后：

```sh
docker compose up --build -d
```

默认只映射到主机 `127.0.0.1:3001`。镜像使用非 root 用户，compose 设置只读根文件系统、移除 Linux capabilities，并只读挂载 `data/`。`CATALOG_PATH=data/catalog.json` 可切换到自己的目录。容器内监听所有地址是为容器网络服务，主机端口仍只绑定回环地址。

如果要与另一台机器或云端站点通信，需另行配置 HTTPS、私有网络与认证；不要直接把端口改为公网开放。此版本没有外部网络抓取，所以不提供所谓“通用 CORS / URL 代理”。

## 验证

```sh
node --check src/catalog.js
node --check src/server.js
node --test
```

自动测试覆盖三类资源、中文和规范化搜索、分页、鉴权、私有缓存、伪造来源头、精确 IP 白名单、限流、错误输入、目录校验、LunaTV 搜索 / 详情，以及签名 HLS 地址的保留。GitHub 工作流使用 Node.js 24 执行相同检查。

这些测试使用本地 HTTP 服务和固定样本，不证明真实第三方源可用，不做内容授权验证、播放器兼容验证或 Docker 运行验证。

## 项目边界与下一步

本项目独立编写，没有复制 Kazumi / LunaTV 源码，也不包含原仓库安装包。公开仓库仅发布程序和演示数据，真实配置、令牌和资源目录保留在本地；公开源码不代表服务已开放到公网。当前尚未选择对外开源许可证；公开可见不等于获得任意修改和再分发授权，后续单独确定许可。

首版完成后，下一步是接入一个有明确授权的 API 源，实现来源状态、更新和错误隔离，再为第二个应用补充检索界面。真实源接入前需明确来源、访问权限和数据协议；不要默认绕过登录、DRM 或站点访问限制。下载客户端、漫画阅读和视频转码应按各自需求另行实现。

不应把此原型描述成已经完成的影视站、BT 搜索引擎或漫画资源站。
