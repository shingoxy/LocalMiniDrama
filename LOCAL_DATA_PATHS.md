# LocalMiniDrama 实际数据路径

验证日期：2026-09-30。当前采用源码模式，以 backend-node 为后端工作目录；相对 database/storage 路径因此从该目录解析。

## 数据库和配置

| 内容 | 完整路径 / 说明 |
|---|---|
| 项目数据库 | `E:\Local AI Video\LocalMiniDrama\backend-node\data\drama_generator.db` |
| SQLite WAL / SHM | 同目录 `drama_generator.db-wal`、`drama_generator.db-shm`；是否存在取决于数据库打开和 checkpoint 状态 |
| 项目、剧集、角色、场景、道具、分镜 | 同一 SQLite 中的 dramas、episodes、characters、scenes、props、storyboards 等表 |
| 生成历史、异步任务、合成记录 | 同一 SQLite 的 image_generations、video_generations、async_tasks、video_merges 等表 |
| AI 配置和 Key | 同一 SQLite 的 ai_service_configs；api_key 明文，额外凭据可能在 settings |
| 提示词和业务设置 | 同一 SQLite；本次未修改业务提示词 |
| 图床 URL 缓存 | 同一 SQLite 的 image_proxy_cache；不是本地图片副本目录 |
| 程序 YAML | `E:\Local AI Video\LocalMiniDrama\backend-node\configs\config.yaml`，被 Git 忽略 |
| 无密钥模板 | `E:\Local AI Video\LocalMiniDrama\backend-node\configs\config.example.yaml` |
| 项目专用代理配置（可选） | `E:\Local AI Video\LocalMiniDrama\.local\proxy.ps1`，被 Git 忽略；未自动创建含代理凭据的文件 |

## 素材目录

根目录：`E:\Local AI Video\LocalMiniDrama\backend-node\data\storage`。

本次实际项目目录：`E:\Local AI Video\LocalMiniDrama\backend-node\data\storage\projects\0001_20260930_Local_Deployment_Tes`。一般规则为 `projects\<4位项目ID>_<创建日期>_<固化剧名>`，名称截取、非法字符替换后固化在项目 metadata；修改剧名不自动迁移旧素材。表格中的类别目录会按使用情况创建，并非已全部产生内容。

| 内容 | 本测试项目对应完整路径 / 规则 |
|---|---|
| AI 角色图 | `E:\Local AI Video\LocalMiniDrama\backend-node\data\storage\projects\0001_20260930_Local_Deployment_Tes\characters` |
| AI 场景图 | `E:\Local AI Video\LocalMiniDrama\backend-node\data\storage\projects\0001_20260930_Local_Deployment_Tes\scenes` |
| AI 道具图 | `E:\Local AI Video\LocalMiniDrama\backend-node\data\storage\projects\0001_20260930_Local_Deployment_Tes\images`；imageService 没有专用 props 图片类别，未关联角色/场景时落 images |
| AI 分镜图 | `E:\Local AI Video\LocalMiniDrama\backend-node\data\storage\projects\0001_20260930_Local_Deployment_Tes\images`，通过数据库 storyboard_id/图像记录区分 |
| 上传参考图和手工上传图片 | `E:\Local AI Video\LocalMiniDrama\backend-node\data\storage\projects\0001_20260930_Local_Deployment_Tes\uploads`；不带 drama_id 的上传落根目录 uploads |
| 视频片段 | `E:\Local AI Video\LocalMiniDrama\backend-node\data\storage\projects\0001_20260930_Local_Deployment_Tes\videos` |
| 合成视频 | `E:\Local AI Video\LocalMiniDrama\backend-node\data\storage\projects\0001_20260930_Local_Deployment_Tes\videos\merged` |
| TTS 音频 | `E:\Local AI Video\LocalMiniDrama\backend-node\data\storage\audio`；现有 TTS 没有按项目目录分层 |
| 角色音色参考上传 | 项目 1 为 `E:\Local AI Video\LocalMiniDrama\backend-node\data\storage\drama_1\characters\voice`；现有 Seedance 2.0 音色上传另用此规则，本次未上传音频 |
| 尾帧衔接图片 | `E:\Local AI Video\LocalMiniDrama\backend-node\data\storage\media\images`；tailFrameLinkService 使用此路径 |
| 无项目的 AI 图片/公共生成物 | `E:\Local AI Video\LocalMiniDrama\backend-node\data\storage\library\characters`、`library\scenes`、`library\images` 等类别 |
| 无项目的视频/合成 | 无项目生成通常落 `...\storage\library\videos`；无项目合成分支使用 `...\storage\videos\merged` |
| 历史/直接上传目录 | `E:\Local AI Video\LocalMiniDrama\backend-node\data\storage\uploads`、`characters`、`scenes`、`images`、`videos` 等仍可能被旧记录引用，不应按“当前命名规则”擅自删除 |

素材库通常通过数据库引用文件，加入素材库不保证复制成另一份文件。以数据库 local_path/ref_image/extra_images 和实际磁盘为准，不能只备份图片库目录。

已实际保存的参考图：

```text
E:\Local AI Video\LocalMiniDrama\backend-node\data\storage\projects\0001_20260930_Local_Deployment_Tes\uploads\20260930T014654_b8a9c797-1dd2-4a22-abbd-3f4885953138.png
```

已实际合成的文件：

```text
E:\Local AI Video\LocalMiniDrama\backend-node\data\storage\projects\0001_20260930_Local_Deployment_Tes\videos\merged\merged_1790733604110.mp4
```

静态访问前缀为 `/static/<相对storage路径>`，前端 3013 会代理到后端；磁盘路径和 URL 不可互换。生成服务会尝试下载云端图片/视频到本地，但失败或第三方链接过期时可能只有远程 URL，备份不能替代尚未下载的远程内容。

## 日志、缓存、工具和备份

| 内容 | 完整路径 |
|---|---|
| 后端 stdout / stderr | `E:\Local AI Video\LocalMiniDrama\.local\backend.stdout.log` / `backend.stderr.log` |
| 前端 stdout / stderr | `E:\Local AI Video\LocalMiniDrama\.local\frontend.stdout.log` / `frontend.stderr.log` |
| 精准停止使用的进程记录 | `E:\Local AI Video\LocalMiniDrama\.local\processes.json`，包含 PID、启动时间、项目根目录 |
| Vite 依赖缓存 | `E:\Local AI Video\LocalMiniDrama\frontweb\node_modules\.vite` |
| npm 缓存 | `C:\Users\28778\AppData\Local\npm-cache`，本机已有，不属于项目数据备份 |
| 合成临时目录 | 本机 os.tmpdir 下 `drama-video-merge`，通常为 `C:\Users\28778\AppData\Local\Temp\drama-video-merge`；不属于长期素材 |
| 本次人工测试和验证报告 | `E:\Local AI Video\LocalMiniDrama\.local`；包含参考 PNG、测试 MP4、协议/生命周期报告和截图 |
| 项目 FFmpeg | `E:\Local AI Video\LocalMiniDrama\backend-node\tools\ffmpeg\ffmpeg.exe` |
| 本机 ffprobe | `C:\Program Files\ffmpeg-8.0-full_build\bin\ffprobe.exe` |
| 备份根目录 | `E:\Local AI Video\LocalMiniDrama\backup` |
| 已验证备份快照 | `E:\Local AI Video\LocalMiniDrama\backup\2026-09-30_1024`，包含 backend-node\data、backend-node\configs、manifest.json；报告在 .local\lifecycle-report.json |

启动日志会被启动脚本重新定向，长期故障取证时先保存副本。脚本没有创建统一独立的图片磁盘 cache；图床缓存目前是 SQLite 表。备份排除 cache/temp/tmp 和日志，不排除 data/storage 中的正式素材。

## Electron 与源码路径不能混用

- Electron 开发模式理论数据路径：`E:\Local AI Video\LocalMiniDrama\desktop\backend-app\data`。但当前 prestart 会清空 backend-app，再复制源码，存在开发数据删除风险；本次未运行。
- 打包版主路径：`C:\Users\28778\AppData\Roaming\localminidrama-desktop\backend\data\drama_generator.db`。
- 打包版素材：`C:\Users\28778\AppData\Roaming\localminidrama-desktop\backend\data\storage`。
- 打包版 YAML：`C:\Users\28778\AppData\Roaming\localminidrama-desktop\backend\configs\config.yaml`。
- 打包版主进程日志：`C:\Users\28778\AppData\Roaming\localminidrama-desktop\main-startup.log`。

这些 Electron 路径依据 desktop/main.js 静态检查，未证明本机已有对应安装或数据。仓库文档中的旧 `%APPDATA%\LocalMiniDrama` 路径不能当作本版本主路径。backup_local.bat 只备份当前源码目录，不备份另一个 Electron 安装的数据。
