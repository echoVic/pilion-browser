# Pilion 宣传片产品截图

候选包：/tmp/pilion-skill-spaces-candidate-20261104/mac-arm64/Pilion.app
运行版本：0.2.0；app.asar SHA256：ede70b3a0ab8e329c159a54e5cae0935036036a679aa108d4ff98a34b3acc590。

临时 profile：/private/tmp/pv-eOo1ff/profile
临时集成 home：/private/tmp/pv-eOo1ff/home
使用 NODE_ENV=test、TMPDIR=/private/tmp，未用个人 profile/token；未读取或打印 token 内容，未连接真实模型，未改产品/测试，未构建或 codesign。

- pilion-product-dark.png (1600×1000)：真实深色主界面、固定标签；前台网页为合成 fixture
- pilion-agent-skill-install.png (1040×1000)：真实设置与安装完成；隔离临时 home
- pilion-agent-spaces-background.png (1600×1000)：真实 CLI 创建的两个后台任务空间；任务内容合成、未启动模型
- pilion-external-approval.png (1600×1000)：真实 CLI browser.type 待审批；草稿 fixture；前台阅读保持不变

采集方式：真实 Electron shell 和可见 WebContentsView 分别 capturePage，按原生 view.getBounds 坐标逐像素合成。窗口捕获本身遗漏子视图，因此这是一份忠实分层截图，非系统桌面单帧截图；产品控件、布局和网页像素均来自实际候选包，未重画或修改产品 UI。只包含本次隔离窗口，不捕获桌面/其他应用。

网页通过已有 E2E fixture 方式注入合成 DOM，并注明“演示内容 · 本地合成网页”；任务名和草稿为合成数据。Space 与待审批卡由实际安装 CLI 产生；审批已拒绝，关闭本次两个 Space 并移除临时安装。无提交按钮/表单提交；截图不证明真实模型任务成功或性能。

可见文本凭证模式检查通过。产品设置里的 external/cli.token 为通用文件名，无 token 值。四张最终 PNG 已逐图视觉复核：网页层完整、中文正常、安装勾选和审批按钮可见；未见 token 值、个人账号、聊天或私密内容。采集进程退出码 0，隔离应用已关闭。

故事板对应：8–20s 使用安装页，20–31s 使用后台 Space 图，31–43s 使用待审批图，43–53s 使用深色主界面。真实截图展示两个任务空间；故事板的三个任务卡片、批准/停止点击动画应标注“功能示意”，不得描述为本次模型执行实录。网页卡片是演示网页内容，不是 Pilion 内置首页。Agent Spaces 共享网站登录状态；本次仅临时 profile 无个人登录，不能宣传为 Cookie/账户隔离。

PNG 校验：

- pilion-product-dark.png：1600×1000，176456 bytes；SHA256 38c83315e1906a70ff04c90f702a448f29c10d4a47c374abdd2bb2aa0878705b
- pilion-agent-skill-install.png：1040×1000，254323 bytes；SHA256 248554b64351ddac633997f38cb714b4ba3358a25bf8ffec255a28bfa19f3e9d
- pilion-agent-spaces-background.png：1600×1000，210253 bytes；SHA256 608392899342d5110e1f12da65a6e4daa29115272911f86b0a09b22c7678cf60
- pilion-external-approval.png：1600×1000，257730 bytes；SHA256 47ac62fa1b2f57b52854828290d0f39579b5f9b275d6b4475fe0b50bf34f4062
