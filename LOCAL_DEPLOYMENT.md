# LocalMiniDrama Windows 本地部署

验证日期：2026-09-30。仓库：<https://github.com/xuanyustudio/LocalMiniDrama>，源码提交 `adaecf71a38277126fbe1e5e0d79664300f855c1`，版本 1.2.8。

源码 backend-node + frontweb 已部署，可以本地编辑、保存、上传参考图、重启和合成视频。真实云端生成未验证：没有使用真实 API Key，也没有运行收费生成。当前运行方式适合后续 Codex 修改代码。

## 1. 启动、停止和地址

项目目录：`E:\Local AI Video\LocalMiniDrama`。

- 双击 [run_dev.bat](<E:/Local AI Video/LocalMiniDrama/run_dev.bat>)：启动后台和 Vite，等待可用后自动打开浏览器。再次双击会复用已启动的服务。
- 双击 [stop_dev.bat](<E:/Local AI Video/LocalMiniDrama/stop_dev.bat>)：停止启动脚本记录的本项目进程及子进程。关闭浏览器窗口本身不会停止服务。
- 前端：[http://127.0.0.1:3013](http://127.0.0.1:3013)。开发时从这里进入。
- Backend：[http://127.0.0.1:5679](http://127.0.0.1:5679)，健康检查 [/health](http://127.0.0.1:5679/health)，API 前缀 `/api/v1`。

两者仅监听 `127.0.0.1`，没有局域网或公网监听。前端通过 Vite 代理 `/api`、`/static` 访问后端，允许的 CORS Origin 已修正。端口被其他程序占用时脚本报错，不结束那个程序；手工启动且未被记录的实例需手动关闭。

PowerShell 等价操作：

```powershell
Set-Location -LiteralPath 'E:\Local AI Video\LocalMiniDrama'
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\run_dev.ps1
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\local_dev.ps1 -Action Stop
```

`-NoBrowser` 可用于只启动服务。执行策略 Bypass 只作用于该次脚本进程，不修改系统策略。服务无自动开机启动设置。

## 2. 本机依赖和已执行操作

| 项目 | 结果 |
|---|---|
| Node.js / npm | 本机已有 Node 24.15.0 / npm 11.19.1；未更换全局 Node |
| Git | 2.49.0.windows.1；完成克隆、检出和初始工作树记录 |
| 后端依赖 | npm install 成功；better-sqlite3 11.10.0 实际加载并完成 SQLite 查询，sharp 实际加载成功 |
| 前端依赖 | npm install 成功，Vite 5.4.21 开发服务与生产构建成功 |
| 数据迁移 | npm run migrate 成功，22 个 SQL 迁移文件及补充字段检查完成；重启可继续使用同一数据库 |
| 编译环境 | 无需另外安装 Visual Studio Build Tools；未安装 CUDA、Docker、本地推理模型 |

上游 backend-node 声明 Node >=18；**本次一键脚本要求 Node >=24.5**，以同时覆盖 Node 原生 http(s) 和 fetch 的环境代理。不要把“仓库最低版本”与“本机启动脚本要求”混为一谈。克隆时 Windows Schannel 认证失败，使用单次 `git -c http.sslBackend=openssl` 完成网络克隆，未修改全局 Git 配置。示例大文件保留 Git LFS 指针，本次运行不依赖这些示例视频/ZIP。

重装依赖时，在各子目录执行；根目录没有 package.json：

```powershell
Set-Location -LiteralPath 'E:\Local AI Video\LocalMiniDrama\backend-node'
npm install --registry=https://registry.npmjs.org --strict-ssl=true
npm run migrate
Set-Location -LiteralPath 'E:\Local AI Video\LocalMiniDrama\frontweb'
npm install --registry=https://registry.npmjs.org --strict-ssl=true
npm run build
```

手工启动可分别在 backend-node 执行 `npm start`、frontweb 执行 `npm run dev`；需要自行管理两个终端和代理变量，stop_dev.bat 不管理手工实例。日常优先使用一键脚本。

## 3. 数据、Config 和 API Key

| 内容 | 完整位置 |
|---|---|
| SQLite | `E:\Local AI Video\LocalMiniDrama\backend-node\data\drama_generator.db` |
| 素材根目录 | `E:\Local AI Video\LocalMiniDrama\backend-node\data\storage` |
| 本地程序配置 | `E:\Local AI Video\LocalMiniDrama\backend-node\configs\config.yaml` |
| 无密钥模板 | `E:\Local AI Video\LocalMiniDrama\backend-node\configs\config.example.yaml` |
| API Key | 上述 SQLite 的 `ai_service_configs.api_key`；其他厂商额外凭据也可能存入该表 settings 字段 |
| 运行日志和进程记录 | `E:\Local AI Video\LocalMiniDrama\.local` |

项目、剧集、生成历史、AI 配置、设置和素材索引都在 SQLite。Key 通过程序配置页输入，**明文保存在本地数据库中**，并非写入源码或默认 YAML。当前没有通用“自动从 GEMINI_API_KEY 环境变量导入配置”的功能；本阶段使用页面配置，不虚构环境变量入口。详细分类见 [LOCAL_DATA_PATHS.md](<E:/Local AI Video/LocalMiniDrama/LOCAL_DATA_PATHS.md>)。

本次删除的是 config.yaml 的 Git 跟踪记录，磁盘上的本地文件保留；数据库、素材、日志、缓存、备份和本地代理配置均被 .gitignore 排除。配置列表不返回 Key，编辑时按需读取单条本地配置；编辑表单的运行时内存仍会接收 Key。配置导出不携带 api_key 的值，所以导入后需重新填写 Key，完整迁移凭据应使用私密本地备份。

已修正日志直接输出 Key、Gemini URL 查询参数带 Key，以及上游错误文本带出已登记 Key 的风险；本地人工 Key 测试验证列表、错误响应、日志和生产 bundle 均未出现该值。没有真实 Key 可供测试，无法承诺所有未来厂商错误或本机其他软件均不泄漏凭据。单机应用没有用户登录系统，能访问此用户文件或本地 API 的其他程序仍可能读取配置。

## 4. Gemini / Gemini Image / Veo 3.1 配置

进入项目创作页，点击右上角 **AI配置** → **AI 配置**。四个 `Google ... (fill key)` 空 Key 模板已保存，并分别设为各自服务类型的默认项。点击相应行 **编辑**，填写你自己的 Key，核对模型列表和默认模型，再点击 **确定**。也可以用 **添加配置** 新建。

| 用途 / 服务类型 | 厂商 | Base URL | API Protocol / 接口规范 | 当前模板模型 |
|---|---|---|---|---|
| 文本/对话 | Google Gemini | `https://generativelanguage.googleapis.com/v1beta/openai` | OpenAI 兼容；文本表单不显示接口规范下拉框 | `gemini-2.5-pro` |
| 文本生成图片（角色、场景、道具） | Google Gemini | `https://generativelanguage.googleapis.com` | Google Gemini（图片 / Veo 视频），内部值 `gemini` | `gemini-2.5-flash-image` |
| 分镜图片生成 | Google Gemini | 同上 | 同上 | `gemini-2.5-flash-image` |
| 视频生成 | Google Gemini (Veo) | 同上 | Google Gemini（图片 / Veo 视频），内部值 `gemini` | `veo-3.1-generate-preview` |

模型名来自当前仓库预设，是可编辑模板，不代表账户当前仍有该模型权限。文本可在模型列表填写账户实际支持的 Gemini ID；图片也可填写当前原生图片模型 ID。不要填普通文本模型来代替图片模型。Google 的文本兼容地址和接入方式见 [官方 OpenAI compatibility 文档](https://ai.google.dev/gemini-api/docs/openai)，图片接口见 [官方图像生成文档](https://ai.google.dev/gemini-api/docs/image-generation)。

实际调用链：

- 文本：OpenAI 兼容流式 `POST .../v1beta/openai/chat/completions`，Bearer Key；本地模拟服务器验证请求和流式解析。
- 图片：原生 `POST /v1beta/models/{model}:generateContent`，`x-goog-api-key` 请求头；参考图默认 inlineData/base64，不需要第三方图床。
- Veo：原生 `POST /v1beta/models/veo-3.1-generate-preview:predictLongRunning` → 响应 operation name → `GET /v1beta/{operationName}` 轮询 → 读取 generatedSamples 中的视频 URI → 下载到本地。仅向 HTTPS Google API 原站发送下载认证头，跨站重定向不携带 Key；模拟测试已覆盖。

Veo 原生端点由客户端固定构造，配置中的提交/查询端点可以留空。已修正模板误写成图片 generateContent 的问题。**不要选“Veo3”中转协议来调用 Google 官方 API**。Veo REST 长任务流程见 [Google 官方 Veo 文档](https://ai.google.dev/gemini-api/docs/veo)。

首次实际验证 Veo 建议在生成选项选 **8 秒、16:9、720p**；页面当前可能默认 5 秒/480p，这不证明官方 Veo 接受这些值。仓库原生 Veo 分支只发送 prompt、可选单张起始图及部分参数，没有完整实现官方的多参考图、尾帧或扩展视频能力。本次未修改故事工作流或这些业务参数。

配置行 **测试**：Veo 改为查询模型信息，不创建收费视频任务；Gemini 文本和图片的测试仍会提交短提示词，可能消耗额度，需由你填 Key 后自行发起。测试通过也不等于完整生成已通过。本次没有点击真实云端测试。

现有页面/源码包含 OpenAI 兼容、Google Gemini、火山引擎/Seedance、Kling、Vidu、通义万相/千问、DeepSeek、Agnes、NanoBanana、xAI、MiniMax、Jimeng 自建 API 等路径；存在配置或协议分支不代表逐家云端验证。TTS 页面提供 MiniMax 预设，后端有 OpenAI 兼容语音路径；没有本次新增的 ElevenLabs 专用实现，也未接入 Seedance 2.5。

## 5. FFmpeg 与 GPU

- 项目内 `E:\Local AI Video\LocalMiniDrama\backend-node\tools\ffmpeg\ffmpeg.exe`：版本 **8.0.1**，已实际运行。
- 仓库无 ffprobe.exe；本机已有 `C:\Program Files\ffmpeg-8.0-full_build\bin\ffprobe.exe`，版本 **8.0**，项目通过 PATH 兜底使用；未新安装全局 FFmpeg。
- 两段人工纯色带音频 MP4 已通过实际剧集 finalize/合成 API 合成为 **2.02322 秒** MP4，H.264/yuv420p + AAC；浏览器可显示预览控件。独立 FFmpeg 尾部帧提取成功。
- 项目现有“尾帧衔接”使用 `-sseof -1 -frames:v 1`，取最后一秒附近的一帧，不保证精确最后一帧；本次仅确认工具提取可用，没有改业务实现，也未验证该按钮的完整衔接流程。
- GPU 硬件编码、硬件解码和云端 AI 性能未做专项测试。当前验证使用 FFmpeg 软件编码，没有配置 CUDA。

工具解析顺序为 FFMPEG_PATH/FFPROBE_PATH → 项目/桌面候选路径 → PATH。以后移动软件时，需确保仍能找到 ffprobe，或在 `.local/proxy.ps1` 中设置完整 `FFPROBE_PATH`；不必因此重复安装整个编译环境。

## 6. Image Proxy 与网络代理

图床默认地址为 `https://imageproxy.zhongzhuan.chat/api/upload`。本机已设置 `image_proxy.enabled: false`、`use_for_gemini: false`、`use_for_video: false`，全局开关会阻止上传函数发送请求。人工参考图仅上传到本机服务；未上传到该第三方地址。Google 原生图片/Veo 使用 base64，无需图床。其他要求公网 URL 的厂商功能可能因此不可用，详见 [IMAGE_PROXY_ANALYSIS.md](<E:/Local AI Video/LocalMiniDrama/IMAGE_PROXY_ANALYSIS.md>)。

本机存在 HTTP_PROXY/HTTPS_PROXY/NO_PROXY 环境设置，启动脚本继承它们，并设置 NODE_USE_ENV_PROXY=1 和严格 TLS 验证。已用本地假代理分别验证 fetch、http.request 经过代理，localhost 经 NO_PROXY 直连；Google 无 Key 请求返回 HTTP 403，证明网络/TLS 可达，不证明账户授权。Node 的原生代理支持见 [Node 24 HTTP 文档](https://nodejs.org/docs/latest-v24.x/api/http.html)。

如需对本项目单独设置，复制 `proxy.example.ps1` 为 `E:\Local AI Video\LocalMiniDrama\.local\proxy.ps1`，取消注释并换成自己的代理地址：

```powershell
$env:HTTP_PROXY = 'http://127.0.0.1:你的HTTP代理端口'
$env:HTTPS_PROXY = $env:HTTP_PROXY
$env:NO_PROXY = 'localhost,127.0.0.1,::1,.aliyuncs.com,.volces.com,.volcengineapi.com,.klingai.com,.vidu.cn'
```

这段配置只影响启动脚本的子进程。国内域名列表可增删，不按国家自动识别；已有 NO_PROXY 在未提供此文件时会被保留。若系统同时设置小写 http_proxy/https_proxy/no_proxy，请将其与大写值统一，避免运行时选择优先级造成歧义。修改后停止并重新启动；不要关闭 TLS 校验来处理代理证书问题。

## 7. 备份、恢复与 Git 更新

双击 [backup_local.bat](<E:/Local AI Video/LocalMiniDrama/backup_local.bat>)：先停止本项目服务，再复制 backend-node/data（含数据库、项目和素材）及 configs，到 `backup\YYYY-MM-DD_HHMM\`；排除 cache/temp/tmp、*.tmp、*.log，不复制 node_modules。随后检查 SQLite integrity_check、部分媒体引用存在性，生成 SHA256 manifest.json。同一分钟已有备份时拒绝覆盖。

**备份完成后服务保持停止；再双击 run_dev.bat 启动。** 当前路径仅按本次默认 data/configs 目录备份；若以后在 YAML 中改为外部数据库或素材路径，需先同步调整备份脚本。备份包含明文 Key，不应上传公共仓库。最近验证备份位置见 `.local/lifecycle-report.json`。

本次最终验证快照：`E:\Local AI Video\LocalMiniDrama\backup\2026-09-30_1024`。恢复时先 stop_dev.bat 并关闭其他手工实例，保留当前数据目录的副本，再把选定备份中的 backend-node/data、backend-node/configs 恢复到原位置；SQLite 的 db/WAL/SHM 属于同一份快照，不能混用不同日期文件。优先在副本执行 verify_backup.cjs 检查可读性，再启动。本次没有覆盖生产目录做破坏性恢复，已对备份副本完成数据库和所有 manifest 文件校验。

更新前先备份；Git 工作树包含本次必要源码修正和文档，当前**没有提交或推送**。初始记录在 `.local/git-status-initial.txt`。只有 config.yaml 取消跟踪的删除记录在暂存区，实际本地 YAML 仍在；其他改动尚未暂存。不能直接 reset/clean/stash 或覆盖这些工作。

```powershell
Set-Location -LiteralPath 'E:\Local AI Video\LocalMiniDrama'
git status --short
git diff
git diff --cached
git fetch origin
git log --oneline HEAD..origin/main
```

fetch 必须成功后才能判断远端更新；Schannel 再次失败时可单次使用 `git -c http.sslBackend=openssl fetch origin`。先检查、明确提交本次源码和无密钥模板/文档，勿加入 data/.local/backup/local config，再整合上游。没有本地提交且工作树干净时可 `git pull --ff-only`；已有本地提交与上游分叉时需正常合并和解决冲突，不能保证 ff-only 成功。更新后检查配置模板差异、运行 npm install、npm run migrate、测试/构建，最后启动验证。不要用模板直接覆盖私人 config.yaml。

## 8. Electron 结论

当前未安装、运行或打包 Electron；浏览器源码方式已满足本阶段部署。Release EXE 对普通使用方便，但与当前源码数据目录不同，不能假定自动共享；当前 desktop 配置为 Electron 28，需单独对齐 native 模块 ABI。

源码 `desktop/npm start` 的 prestart 会复制后端；`copy-backend.js` 会删除整个 desktop/backend-app，而开发时数据库也位于该目录。直接反复启动存在丢失开发数据的风险，现阶段不推荐作为长期调试入口。以后若切换 Electron，应先修正开发数据生命周期并验证代理/TLS、ABI 和迁移；本次未为此扩大修改范围。打包版的实际目录为 `%APPDATA%\localminidrama-desktop\backend`。

## 9. 验证结果和已知限制

| 验证项 | 结果 / 证据 |
|---|---|
| Backend、Frontend、首页 | 通过；health/API/页面 HTTP 200，实际监听均为 127.0.0.1 |
| 新建、故事梗概、保存 | UI 创建项目 1：Local Deployment Test - Harbor Mystery；人工剧本保存于第 1 集 |
| 关闭、重启、数据仍在 | 通过；两次重启核对项目、剧本、四个 AI 模板 |
| 上传、重启后参考图仍在 | 通过；人工 320×180 蓝色 PNG；SHA256 `b7e15a2baedc0e2410c232c59fd2f69c6514dbdda495fea8780f4c1ff817f47b` 一致，静态文件 HTTP 200 |
| 精准停止 | 通过；两个端口释放，另一个测试 Node 进程存活 |
| FFmpeg / ffprobe | 版本命令、应用合成 API、时长探测、独立尾部帧提取通过 |
| AI 配置页面 | 文本、图片、分镜图片、Veo 模板可编辑；全部 Key 为空 |
| Gemini / Veo 协议 | 本地模拟验证文本流式、图片认证头、Veo 8 秒提交与轮询、Google 下载认证及跨站重定向保护 |
| CORS | 合法本地 Origin 200；外站 Origin 403 |
| 密钥边界 | 人工 Key 的列表隐藏、错误/日志脱敏、bundle 隔离测试通过；测试后 Key 恢复为空 |
| Image Proxy | 全局禁用情况下零网络上传的测试通过 |
| 备份 | SQLite integrity_check=ok，所有 manifest 文件哈希与人工参考图一致 |
| 自动测试 / 构建 | 后端 78/78，前端 10/10；Vite 生产构建成功；仓库没有 lint 配置 |
| 日志 | 稳定运行无持续严重错误；开发热重载期间曾短暂 ECONNREFUSED；人工上游拒绝测试产生一次已脱敏错误，均不代表持续服务故障 |

本地报告和测试日志位于 `.local`，验证图片见 `.local/deployment-reference-verified.png`、`.local/deployment-ai-config-verified.png`。测试项目、两个人工视频片段及合成视频保留，便于之后检查；没有真实云端内容。

仍有上游依赖风险：当日 npm audit 后端 **13** 项（4 moderate、8 high、1 critical），前端 **26** 项（16 moderate、10 high）；critical 包含火山 SDK 的 protobufjs 依赖链。没有执行 npm audit fix 或未经验证的大规模升级。Vite 构建有大于 500KB 的 chunk 警告。仅本机监听、Origin 校验和严格 TLS 减少暴露，但不等于依赖漏洞已修复。

未验证：真实 Key/额度/地区和模型权限、云端完整生成、TTS、各第三方厂商、Electron、硬件 GPU 编解码、所有小说导入/导出与高级业务按钮。不能据此宣称“全部功能已通过”。

下一步最合适：由你填写真实 Google Key，先确认可用文本/图片模型，再各做一次小规模生成，最后做 8 秒 Veo 单镜头并确认下载保存；记录返回错误和费用后，再决定依赖升级或 Electron 修正。Seedance 2.5、ElevenLabs、Ideation 和工作流改造保持后续范围。
