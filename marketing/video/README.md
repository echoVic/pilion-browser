# Pilion 宣传片

62 秒 / 1920×1080 / 30 fps，Remotion 4.0.540，中文女声与原创轻电子背景音乐。

```sh
npm ci
npm run lint
export PILION_RENDER_BROWSER='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
npm run render
npm run poster
```

本机下载的 Headless Chrome 在等待动画帧时超时；同一工程使用上面的独立 Chrome 渲染环境成功。其他机器可把 `PILION_RENDER_BROWSER` 指向可用的 Chromium 可执行文件，或不设置它使用 Remotion 默认下载环境。视频输出需用 `ffmpeg -i out/pilion-promo-zh.mp4 -c copy -movflags +faststart out/pilion-promo-zh-web.mp4` 转为渐进播放文件后放到官网。

重新生成配乐时依次运行 `python3 scripts/generate-music.py`、`python3 scripts/generate-voiceover.py` 和 `bash scripts/mix-audio.sh`，需要 Python NumPy、已安装的 edge-tts 与 FFmpeg。已有音频和字体随工程保留，常规渲染不访问 TTS 服务。

旁白逐场景自然合成，时间表与字幕位于 `public/audio/manifest.json`。配音不变速。音乐由 `scripts/generate-music.py` 本地合成，无第三方歌曲或采样。音乐在解说期间通过 sidechain compression 压低，混合响度目标 −16 LUFS、true peak −1.5 dBTP，首尾淡入淡出。最终 `public/audio/mix.m4a` 是供渲染使用的混音。

语音使用已安装的 edge-tts（Microsoft Edge 在线晓晓标准声），只发送公开宣传文案，无克隆/模仿真人，来源不代表付费商业授权认证。可运行 `python3 scripts/generate-voiceover.py` 复用现有音频或显式 `--regenerate`。字幕同步于实际语音，官网使用 `public/captions-zh.vtt`。

字体 Noto Sans SC，SIL Open Font License，见 `public/fonts/OFL.txt`。Pilion 标志使用项目官方图标。四张产品截图来自实际 0.2.0 候选包的隔离演示环境，详细来源见 PRODUCT-CAPTURE.md；网页是合成演示内容。卡片、终端指令和审批强调动画属于功能示意，不是模型性能实录。

脚本见 STORYBOARD.md。桌面应用和视频工程的依赖分别安装，渲染输出 `out/` 不提交。发布资产使用带版本文件名，网页由用户主动播放，不自动播放声音。
