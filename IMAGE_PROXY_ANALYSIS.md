# Image Proxy 实现与本机策略

检查日期：2026-09-30。依据 backend-node/src/services/uploadService.js、imageClient.js、videoClient.js、jimengMaterialHubService.js，以及本地 config.yaml。这里的 Image Proxy 是图片上传图床，与 HTTP_PROXY/HTTPS_PROXY 网络转发代理不同。

## 1. 默认服务和上传去向

默认上传端点为 `https://imageproxy.zhongzhuan.chat/api/upload`。代码用 multipart/form-data 上传，字段名为 `file`，期望响应 JSON 中返回 `url`，随后把该公网 URL 交给相应 AI 服务获取参考图。

图片内容会先发送到上述第三方域名；返回 URL 的实际存储域名、运营者、删除政策和访问控制没有在本仓库中得到证明。不能由域名或“本地短剧”名称推断它是本地/私有存储。本次没有向该服务上传文件，也没有验证其保留政策。

SQLite image_proxy_cache 保存图片标识对应的 proxy_url 和 created_at，减少重复上传。本地配置 expire_hours=2 只控制客户端 URL 缓存过期，不表示服务端一定两小时删除图片；代码省略配置时另有默认值，不能当作保留承诺。

## 2. 哪些模型需要公网 URL

| 当前路径 | 是否需要第三方图床 |
|---|---|
| Google Gemini Image 原生 `gemini` | 不需要。默认 inlineData/base64，可直接发送本地/人工参考图给 Google |
| Google Veo 原生 `gemini` | 不需要。代码把可选起始图转换为 bytesBase64Encoded，不调用默认图床 |
| 火山/Seedance 全能、多图参考 | 公网图片 URL 可直传；本地图默认转换为 base64；use_for_video=true 时可选图床。不是所有 Seedance 都必须图床 |
| 即梦素材/角色认证相关路径 | 某些网关要求可访问的图片 URL，具体取决于接入协议和资产方案；可能调用图床转换。不能把资产认证与普通 Seedance 视频生成混为一谈 |
| NanoBanana 等图片中转、Agnes 视频、Vidu、Veo3 中转等 URL 型接口 | 当前部分路径会尝试把本地图或 base64 转换为公网 URL；关闭图床后，已有公网参考图仍可能可用，但本地参考图相关功能可能失败 |
| Kling / 其他自定义 API | 按具体接口的 URL/base64 支持判断；存在分支并不证明所有模型都必须或都不需要图床 |

远端服务器无法访问本机 `http://localhost:5679/static/...`，也无法读取 Windows 磁盘路径。要求 URL 的接口必须得到它可访问的 URL，但该 URL 不必来自默认服务，可以来自你自己的合规存储。当前未接入 Seedance 2.5，不能依据其他版本的代码保证其要求。

## 3. Gemini Image 与 Veo 的具体判断

Gemini Image 的 use_for_gemini=false 分支用 inlineData；设为 true 则会尝试图床后用 fileData.fileUri，失败时有回退。上传成功也不证明 Google 接受该第三方 file URI。本阶段保持 false，使用原生图片方式，见 [Google 图像生成文档](https://ai.google.dev/gemini-api/docs/image-generation)。

原生 Veo 提交 predictLongRunning 时支持代码中的单张起始图 base64。`api_protocol=veo3` 是另一类中转协议，不能套用“官方 Veo 不需要图床”的结论。官方参考见 [Google Veo 文档](https://ai.google.dev/gemini-api/docs/veo)。真实 Google 内容传输和云端生成需你填 Key 后自行验证；本次只运行本地模拟。

## 4. 是否可以禁用

可以。本次增加统一 `image_proxy.enabled` 开关，在 uploadToImageProxy 发出网络请求之前检查。只关闭 use_for_gemini/use_for_video 不覆盖所有中转路径，因此全局开关更明确。

本机 `E:\Local AI Video\LocalMiniDrama\backend-node\configs\config.yaml` 当前设置：

```yaml
image_proxy:
  enabled: false
  use_for_gemini: false
  use_for_video: false
  expire_hours: 2
  upload_timeout_seconds: 180
  upload_max_attempts: 2
```

未设置 upload_url 时才回退默认地址；开关仍会先阻止网络上传。配置模板也使用关闭状态。本地测试验证禁用后上传函数返回 null，零外部网络请求。禁用不影响浏览器向本地 `/api/v1/upload` 上传图片和磁盘持久化，也不禁止以后显式生成时发送参考图给你选择的 AI 厂商。

## 5. 将来换成 R2 / OSS / COS

可以，但当前 upload_url **不是通用对象存储 SDK 或 S3 直传接口**。直接把 URL 换成 bucket 地址通常不可行：项目期待 `POST multipart(file)` → `{ "url": "..." }`，而对象存储通常需要签名、认证或不同上传结构。

最小后续方案是你控制的上传适配器（例如 Worker 或小服务）：接受上述 multipart 请求，在服务端完成 R2/OSS/COS 鉴权和存储，返回模型可访问的图片 URL。凭据留在适配器服务端，配置访问控制、文件类型/大小限制、实际删除周期；若用短期签名 URL，有效期必须覆盖 AI 排队、重试及轮询时长，并同步本地缓存 TTL。

也可将来修改当前上传函数使用对应 SDK，但属于单独接入工作，本次没有增加 SDK、云服务、bucket、付费资源或上传适配器。应在选定厂商和隐私策略后再做。

## 6. 当前验证和限制

- 人工 320×180 蓝色参考图只进入本地素材目录，重启后文件和哈希一致。
- Google 图片、Veo base64 请求及认证行为完成本地协议模拟。
- 全局禁用图床的零网络行为通过自动测试。
- 默认图床的实际可用性、图片删除时间、私有访问及各第三方模型对 URL 的要求未作云端测试。

当前默认关闭适合你的 Gemini Image + 官方 Veo 目标。将来确实选择 URL 型厂商接口时，再决定可信自有存储，不应为部署验证自动上传私人素材到未知服务。
