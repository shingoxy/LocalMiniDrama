# 欧美短剧云端模型预设

已在现有 Windows / Node.js / Vue 部署中加入模型预设与参数兼容，未改变部署脚本、数据库结构或原有创作流程。核对官方文档日期：2026-09-30。

## 在 UI 填写 API Key

打开 <http://127.0.0.1:3013>，右上角「AI配置」。本机已应用一次「一键配置欧美短剧」，四条新配置均设为默认，API Key 留空。

| 配置行 | 点「编辑」后，在「API Key」中填入 | Base URL |
|---|---|---|
| 欧美短剧 · DeepSeek 官方 | DeepSeek 官方 API Key | `https://api.deepseek.com` |
| 欧美短剧 · Seedream 5.0 Pro · 角色场景 | Ark API Key | `https://ark.cn-beijing.volces.com/api/v3` |
| 欧美短剧 · Seedream 5.0 Pro · 分镜 | 同一个 Ark API Key | 同上 |
| 欧美短剧 · Seedance 2.5 | 同一个 Ark API Key | 同上 |

每条编辑后点击「确定」。DeepSeek Key 与 Ark Key 分开填写；模型列表和「默认模型」可以编辑。Ark 接入点 ID（`ep-...`）也可填入模板的模型列表并选为默认，模板中的版本设置会继续用于参数校验。切换为列表内的 Seedream 4.5 / Seedance 2.0 时，优先使用实际模型名对应的旧版规则。

DeepSeek Key 可在 [DeepSeek 控制台](https://platform.deepseek.com/api_keys)获取；Ark Key 可在[火山方舟 API Key 管理](https://ark.volcengine.com/region:cn-beijing/apikey)获取。实际使用前需确保账号有对应模型权限。

重复点击一键配置会复用同名模板，保留已填写的 Key 和已编辑的模型。已有 Google / Gemini / Veo 配置继续保留；Kling 厂商与调用链继续可作为备用视频模型，在 AI 配置中添加/编辑相应配置并切换默认即可。本次未调用任何真实生成或付费 API。

## 新增推荐模型

| 用途 | 推荐默认值 | 复用的实现 |
|---|---|---|
| 文本 | `deepseek-flash`，可选 `deepseek-v4-pro` | 现有 OpenAI-compatible 文本客户端 |
| 角色、场景、道具图 | `doubao-seedream-5-0-pro-260628` | 现有火山图片 Provider |
| 分镜图 | 同上 | 现有 storyboard_image 配置与图片客户端 |
| 视频 | `doubao-seedance-2-5-260628` | 现有 volcengine_omni 与任务轮询 |

模型 ID 来自[火山模型发布公告](https://docs.volcengine.com/docs/ark/model-release-announcement?lang=zh)。DeepSeek 推荐名和地址来自[官方入门文档](https://api-docs.deepseek.com/guides/harness)。这些是可编辑的默认值，客户端未锁定模型名。Seedream 4.5、Seedance 2.0 和已有厂商选项均保留。

## Seedream 5.0 Pro 参数

支持文生图、单参考图和多参考图（最多 10 张），参考图继续使用 `image` 字段。支持明确的 9:16 像素尺寸；新版本使用 921600–4624220 像素范围，支持 `1K`、`1.5K`、`2K` 档位。不再套用旧图片模型的最低 3686400 像素规则。项目尺寸超出范围时等比调整，保持画幅。

新模型请求省略未列入官方规范的 `n`、`quality`、`negative_prompt` 等字段；负向要求并入提示词。旧模型请求保持原有行为。参考：[官方图片生成 API](https://docs.volcengine.com/docs/ark/image-generation-api?lang=en)。

## Seedance 2.5 与现有 2.0 的区别

| 参数 | Seedance 2.0 保持兼容 | Seedance 2.5 新处理 |
|---|---|---|
| duration | 4–15 秒，支持 `-1` | 4–30 秒，支持 `-1`；未传入时使用官方默认 `-1` |
| resolution | 保持现有参数透传 | 校验 480p / 720p / 1080p，未传入时 720p |
| ratio | 保持已有画幅逻辑 | 支持 16:9、4:3、1:1、3:4、9:16、21:9、adaptive |
| 多参考图 | 最多 9 张 | 最多 30 张，UI 和后端解除旧上限，超出数量明确报错 |
| 首帧/尾帧 | 保留经典调用，并补全 Omni 透传 | 使用 first_frame / last_frame；自动设 adaptive，跟随首帧画幅 |
| 同步音频 | 保留原行为；显式设置可传 generate_audio | 默认开启，可在视频配置「同步音频」开关关闭 |
| 参考音频 | 保留现有音色参考入口 | 允许仅传参考音频；两版首尾帧模式均避免自动混入角色音色 |
| 其他字段 | 保留已有请求 | 不再发送旧 task_type、seed、camera_fixed 字段 |
| 轮询 | 复用原任务接口 | GET 同一任务路径，解析 content.video_url，过期状态立即作为失败处理 |

首尾帧模式不能与多参考图/参考音频模式混用；生成 9:16 首尾帧视频时，输入首帧也应为 9:16。选中 Seedance 2.5 为默认后，制作页「每段秒数」新增 20/25/30 秒选项；分镜配置中的秒数输入继续可用。

官方还支持视频编辑、延长及更多视频/音频参考输入；本次按最小改动范围保留现有入口，没有新增这些业务流程。编辑类任务要求 duration=-1、ratio=adaptive；项目当前入口不提交视频编辑任务。依据：[视频生成 API](https://docs.volcengine.com/docs/ark/create-video-generation-task-api?lang=zh&redirect=1)、[Seedance 2.5 提示词指南](https://docs.volcengine.com/docs/ark/seedance-2-5-prompt-guide?lang=en)。

## 新 Prompt 预设

「图片/视频风格」新增「欧美短剧（英文 / 竖屏）」。一键配置后新项目默认采用该预设、9:16 和英文分镜语言，已有项目保持原有设置，可手动选择新预设。

故事生成仅在该预设下追加说明：US / English-speaking audience，TikTok / YouTube Shorts / Instagram Reels，自然 American English，前 3 秒强钩子，快节奏，每集 60–90 秒，强 cliffhanger，避免翻译腔。保留原 JSON 格式、集数及用户提供的梗概，没有增加自动故事创意功能，也没有修改原 Prompt。

60–90 秒是整集的写作要求；30 秒是单次视频生成上限，整集继续使用现有分镜与合成流程。

## 本次修改文件

- 后端预设与默认值：`backend-node/src/services/westernShortDramaPreset.js`（新增）、`src/routes/aiConfig.js`、`src/routes/index.js`、`src/routes/settings.js`、`src/services/dramaService.js`。
- 后端请求与 Prompt：`backend-node/src/services/imageClient.js`、`src/services/videoClient.js`、`src/services/storyGenerationService.js`、`src/constants/generationStylePresets.js`。
- 前端入口与选项：`frontweb/src/api/ai.js`、`src/components/AIConfigContent.vue`、`src/constants/styleOptions.js`、`src/views/FilmList.vue`、`src/views/FilmCreate.vue`。
- 测试：`backend-node/test/cloudModelPresets.test.js`（新增）、`frontweb/test/styleOptions.test.js`。
- 说明：本文件。

上面的简写路径分别相对于 backend-node / frontweb；工作区中此前部署产生的其他改动已保留，不属于本次模型修改。

## 验证

- 后端：`node --test test/*.test.js`，88/88 通过（新增 10 项）。
- 前端：`node --test test/*.test.js`，11/11 通过（新增 1 项）。
- 前端：`npm run build` 通过；仍有原有大 bundle 警告。
- `git diff --check` 通过。

测试使用内存 SQLite、本机 HTTP mock 和合成 Key，未请求真实云端生成。覆盖 DeepSeek 可编辑模型名与流式兼容、Seedream 文生图/参考图/多参考图/像素范围、Seedance 时长/分辨率/画幅/首尾帧/参考音频/同步音频/轮询，以及旧模型和已有配置保留。

页面已验证：一键创建四条空 Key 配置并设为默认、视频同步音频开关、新版 20/25/30 秒选项、新项目默认 9:16。真实账号权限、计费、生成质量未做实调验证。
