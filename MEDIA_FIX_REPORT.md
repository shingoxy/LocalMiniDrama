# 英文成片、原声与合成任务修复

验证日期：2026-09-30。沿用现有 Windows / Node / Vue 部署；未调用真实付费生成 API。

## 结论与操作

- 当前项目的 `script_language` 仍为 `zh`，仅新增 `media_language: en`。刷新创作页后，顶部可选择“成片语言：英文”，独立于分镜/剧本语言。
- 英文成片提交前，使用现有文本模型转换中文媒体提示词、对白及需要显示的文字；英文校验失败会停止提交。Seedance 素材引用标签保持原样，Seedream 可信原始 URL 的传递不受影响。
- 图片/视频提示词增加 American English 限定，并禁止擅自添加字幕。合成时生成的旁白字幕、旁白 TTS 及单独生成的 TTS 使用英文；不修改原有中文剧本和分镜正文。
- 已生成图片/视频内的中文不会自动消失，需要在英文成片设置下重新生成相应素材；本次没有执行付费重新生成。
- 模型生成的画面文字不能靠提示词保证百分之百正确。火山官方 Seedance 2.5 指南也说明“无字幕”仍可能不生效，仍需检查生成结果：[官方指南](https://docs.volcengine.com/docs/ark/seedance-2-5-prompt-guide?lang=zh)。尤其应先更换含中文文字的参考图。

## 声音与合成

- 抽查三段原始视频，均有立体声 AAC 音轨和非静音声音。当前 24 个分镜只有 2 个带对白，多数镜头主要是环境声。
- 画布缩略视频设置了 `muted`；点击视频节点查看完整播放器，或打开分镜详情里的带控件播放器，再检查音量按钮和系统音量。
- 原成功合成记录 #6 的平均和最大音量均为 −91 dB。原因是勾选配音/旁白，但没有音频素材时，代码生成静音轨并替换原声。现已在没有配音素材时保留原音；有配音时与原声混合。
- 原失败记录 #3–#5 的日志显示合成过程中后台重启（其中两次已完成 FFmpeg 拼接），启动时任务被标为中断。具体触发后台重启的文件/事件未确认。修复方式是保存合成进度和拼接输出，重启后恢复本地合成；同时同步旧中断记录状态，避免长期停留在 processing。
- 合成后处理失败会同时标记合成记录和任务失败，不再静默忽略字幕/音频错误。完成状态和任务结果在同一事务内保存。

## 已完成的验证

- 后端：109/109；前端：11/11；前端 `npm run build` 成功。
- 一次并行后端测试的既有 `localDeploymentSafety` 测试进程异常退出；其单独复验 8/8 通过，全部后端串行复验 109/109 通过。
- 新 mock 覆盖：英文转换和校验失败、Seedance 引用标签、Seedream 原始 URL 直传、generate_audio=true、空配音不覆盖原声、原声与配音混音、英文 SRT/TTS、保存的合成输出恢复、后处理错误、取消任务不恢复。
- 真实本地验证：创建含已有 24 段视频的待合成任务，使用原启动脚本受控重启，任务 #7 自动恢复完成。
- 再通过创作页使用的 `/episodes/1/finalize` 入口合成，任务 #8 正常完成。两次均无付费 API 调用。
- 最新合成文件：`backend-node/data/storage/projects/0001_20260930_Local_Deployment_Tes/videos/merged/merged_8_1790750492324.mp4`。
- FFprobe 检测：H.264 视频、AAC 32000 Hz 立体声，实际时长 121.92 秒；平均音量 −28.3 dB，最大音量 −4.9 dB。新结果已写入当前分集，刷新页面查看最新合成。
- 未做云端付费生成验收；英文画面实际效果需要下次生成后检查。

## 存储目录

默认存储根目录：`E:\Local AI Video\LocalMiniDrama\backend-node\data\storage`。

当前项目位于 `projects\0001_20260930_Local_Deployment_Tes`：

- 分镜图片：`images`；角色、场景、道具图片还分别位于 `characters`、`scenes`、`props`。
- 分镜视频：`videos`。
- 合成视频：`videos\merged`。
- TTS 音频：存储根目录下 `audio`。
- 数据库：`E:\Local AI Video\LocalMiniDrama\backend-node\data\drama_generator.db`。

## API Key 和模型选择

打开“AI 配置”，编辑相应配置，在 `API Key` 输入框填写后保存：

- 文本：`欧美短剧 · DeepSeek 官方`，填写 DeepSeek Key。
- 角色/场景/道具图片：`欧美短剧 · Seedream 5.0 Pro · 角色场景`，填写 Ark Key。
- 分镜图片：`欧美短剧 · Seedream 5.0 Pro · 分镜`，填写 Ark Key。
- 视频：`欧美短剧 · Seedance 2.5`，填写 Ark Key，默认模型选择 `doubao-seedance-2-5-260628`，勾选“设为默认”。该预设启用 generate_audio=true。

当前另一个视频配置被选为默认，模型是 `doubao-seedance-2-0-fast-260128`；本次未替换用户已选择的模型。若要使用 2.5，请按上一项切换。既有生成记录的 model 字段为空，不能仅凭这些记录断言旧视频具体用了哪个模型。

## 本次代码改动清单

| 文件 | 改动 |
| --- | --- |
| `backend-node/src/services/mediaLanguage.js`（新增） | 独立成片语言、复用文本客户端转换、英文校验、保留素材引用标签 |
| `backend-node/src/services/imageClient.js` | 图片提交前应用成片语言 |
| `backend-node/src/services/videoClient.js` | 视频提交前应用成片语言，保留原始素材链路 |
| `backend-node/src/services/ttsService.js` | 英文项目的 TTS 输入转换 |
| `backend-node/src/services/westernShortDramaPreset.js` | 欧美预设增加英文成片默认值 |
| `frontweb/src/views/FilmCreate.vue` | 增加成片语言选择并保存项目 metadata |
| `backend-node/src/services/mergedEpisodePostProcess.js` | 空配音保留原声、混音、英文字幕/旁白、完成前保留中间文件 |
| `backend-node/src/services/videoMergeService.js` | 保存拼接进度、恢复任务、同步失败状态、事务保存完成结果、错误处理 |
| `backend-node/src/services/taskService.js` | 启动时保留可以恢复的合成任务 |
| `backend-node/src/app.js` | 启动恢复本地合成任务 |
| `backend-node/test/mediaLanguage.test.js`（新增） | 英文媒体及可信图片传递 mock 测试 |
| `backend-node/test/videoMergeRecovery.test.js`（新增） | 音轨、字幕和任务恢复 mock 测试 |

没有新增模型、删除旧模型或迁移数据库；没有修改部署脚本。配置变更只有当前项目的成片语言；原剧本语言、画幅和风格保留。
