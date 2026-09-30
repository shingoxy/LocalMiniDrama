# LocalMiniDrama 本地部署分析

检查日期：2026-09-30。源码：<https://github.com/xuanyustudio/LocalMiniDrama>；检出提交 `adaecf71a38277126fbe1e5e0d79664300f855c1`，版本 1.2.8。初始 Git 工作树干净。依据 README、docs/quickstart.md、docs/configuration.md 和实际 backend-node/frontweb/desktop 源码。

1. **本机推荐方式**：源码 backend-node + frontweb，仅监听 127.0.0.1。适合后续 Codex 修改和 Vite/Node 调试；不需要 Docker、反向代理、CUDA。
2. **Release EXE 与源码**：EXE 自带 Electron 和打包代码，普通使用方便；源码的依赖、日志、调用链更易检查。两种方式的数据目录不同，不能假定自动共享。
3. **后续开发**：保持此 Git 仓库，使用修正后的 run_dev.bat；改动独立于被忽略的数据库、密钥和素材。Electron 开发模式会复制后端到 desktop/backend-app，需重新启动同步，并使用 Electron 专用 native ABI；本阶段以浏览器为主。
4. **Node**：backend-node/package.json 要求 >=18；本机 Node 24.15.0/npm 11.19.1。better-sqlite3 ^11.6.0 和 sharp 有 native 依赖，先验证安装及真实加载；若 Node 24 不兼容，采用项目内便携 Node 22，不修改全局 Node，也不无理由安装编译环境。
5. **FFmpeg**：仓库已有 backend-node/tools/ffmpeg/ffmpeg.exe（约 99MB），没有 ffprobe.exe；解析顺序为环境变量、项目/桌面候选位置、系统 PATH。本机系统已有 FFmpeg/ffprobe 8.0，可用于 ffprobe 兜底。Electron 打包支持从 extraResources 复制 FFmpeg，不代表所有 Release 都一定包含完整工具。
6. **SQLite**：源码以 backend-node 为工作目录，路径 E:\Local AI Video\LocalMiniDrama\backend-node\data\drama_generator.db；WAL 模式。项目、配置、生成历史、素材索引均在这个数据库，不重建已有数据库。
7. **素材**：根目录 E:\Local AI Video\LocalMiniDrama\backend-node\data\storage；按 projects/<项目编号>_<创建日期>_<固化剧名> 分层，公共素材放 library 或历史类别目录。音频、视频、合成文件另有子目录，部署后详列 LOCAL_DATA_PATHS.md。
8. **密钥**：通过 AI 配置页面保存到 SQLite 的 ai_service_configs.api_key，明文存储；不是 YAML 中的常规 AI Key。数据库应视为私密本地配置并排除 Git，备份也包含 Key。原始列表 API 含 Key，修正为列表隐藏 Key、编辑按需访问单条本地配置；运行时表单仍会接收 Key，不会嵌入前端静态 bundle。日志需要脱敏，防止上游错误或 URL 意外带出 Key。

## 已确认的部署缺口

- README 要求复制 configs/config.example.yaml，但仓库只有已跟踪的 configs/config.yaml；需建立无密钥模板并忽略本地 YAML。
- 默认后端和 Vite 监听 0.0.0.0，后端 cors_origins 写为 3012，server.insecure_tls=true；改为本地监听、准确 CORS 和正常证书验证。
- run_dev.bat 粗暴结束端口占用进程、路径未正确处理空格，输出端口错误；需按项目路径和 PID 管理，提供精准停止、备份。
- 文本使用 Node http(s)，图片/视频同时使用 http(s) 和 fetch；不能假定 HTTP_PROXY/HTTPS_PROXY 自动覆盖所有请求。需核实 Node 当前代理能力，并覆盖两类客户端，支持 NO_PROXY。
- Gemini Image 有原生 gemini 协议；Veo 有原生 gemini 与中转 veo3 协议，应区别。文本原生 Gemini generateContent 没有接入，使用 Google 官方 OpenAI 兼容 Base URL。
- image_proxy.use_for_video 默认 true，Gemini 图生可显式禁用图床；本机先关闭图床上传，不上传任何私密/测试素材到默认外部服务。

## 部署与验证顺序

安装 backend/frontend → 迁移/加载 native SQLite → 修正部署与密钥边界 → 启动/检查监听及 CORS → 浏览器新建、保存、上传、重启持久化 → 本地 FFmpeg 合成与尾帧提取 → 无真实 Key 的 AI 配置及本地协议模拟 → 备份恢复可读性检查 → 更新最终部署与数据路径文档。

云端生成成功、账户额度、地区权限和当前模型可用性，需要用户之后填入真实 Key 验证。本次不运行收费 AI 生成。

部署后确认：Node 24.15.0 的 SQLite/sharp 实际加载成功，无需备用 Node 或新增 Build Tools；一键脚本采用 Node >=24.5 的内置环境代理。Electron 开发复制脚本会清空 backend-app（包含开发数据），本阶段继续使用浏览器源码模式。最终结果见 LOCAL_DEPLOYMENT.md。
