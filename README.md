# orbit-plugin-dsh-pet · DSH 桌宠桥接

把开源社区的 **dsh-pet**（[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的桌宠插件，那只 4.9k star 的鲸鱼娘）接入 [Orbit Toolbox](https://github.com/Ikaros-521/orbit-tools)：
在工具箱里**一键安装、启停监管、健康探活**，并通过它的官方 API **让它念话、点播 106 段透明动画、自由碎碎念**，还能把「让桌宠说剪贴板」绑成全局热键。

## 工作方式：进程接管，零修改

dsh-pet 官方自带**独立模式**（standalone）——不依赖 DSH，宿主半侧跑在它自己的伪 ctx 上，
本机 HTTP 服务接管路由，桌宠显示在透明置顶窗里。本桥接插件做的就是把这套独立模式
收编进工具箱：

```
Orbit Toolbox ──(spawn, ELECTRON_RUN_AS_NODE)──▶ dsh-pet standalone（本机 HTTP 服务）
      │                                              │
      │  ~/.dsh/dsh-pet/standalone-runtime.json      │ 自动下载 Electron 运行时 →
      │  读取端口 + 能力令牌 + 设置页地址              ▼
      └── petApi 白名单转发（state/whisper/broadcast/  透明置顶桌宠窗（106 段 webm）
         anim/position/throw…，写操作自动带令牌头）
```

为什么这样移植，而不是把它改成工具箱的内嵌窗口：

- **上游零修改** —— 升级跟官方 npm 包同步（面板一键更新 `dsh-pet@latest`），官方迭代很快（每周多版）
- **功能全量** —— 碎碎念 AI、对话记忆、待办、节日动画、多宠物、右键菜单、余额…… 全部原样保留，不阉割
- **许可隔离** —— 鲸鱼娘形象素材是 CC BY-NC-SA 非商用授权，从官方 npm 包安装进你本机数据目录；**本仓库不含任何 dsh-pet 代码与素材**
- 与 [orbit-plugin-pet](https://github.com/Ikaros-521/orbit-plugin-pet)（自研小轨桌宠，内嵌窗口 + cordis-lite）互补：一个是**外部进程接管**，一个是**进程内移植**，覆盖 DSH 伴随类插件移植的两种形态

## 安装（Orbit Toolbox 用户）

1. 下载/克隆本仓库到工具箱用户插件目录（`设置 → 插件 → 打开用户插件目录`，解压即插件）
2. 重启工具箱，打开「DSH 桌宠」面板
3. 点 **一键安装 dsh-pet**（npm + npmmirror，约 90MB，十几秒；可选镜像/代理）
4. 点 **启动**——首次会自动下载桌宠窗口所需的 Electron 运行时（约 130MB，官方内置国内镜像）
5. 桌面右下角出现鲸鱼娘。**右键它 → 打开 AI 设置**配置 API key 后，「自由发挥」（AI 碎碎念）即可用

其他装机方式：
- **选择已有安装目录**：指到含 `lib/standalone.js` 的 dsh-pet 包目录，或含 `dsh-pet.exe` 的绿色包目录
- **接管外部实例**：你已用官方方式跑着 standalone？面板一键接管，API 照常联动

## 联动

- 面板互动区：`念这句话`（投喂气泡）、`自由发挥`（AI 生成）、动画下拉直接点播任意一段
- 动作抽屉 / 热键：
  - `启停 DSH 桌宠`——一键开关
  - `让桌宠说剪贴板`——复制任何文本后按热键，桌宠立刻念出来
- API 白名单（`call` 转发）：`state / pose / whisper / broadcast / bubble-clear / anim / position / throw / chat / balance / lock`——给工作流编排预留，后续可在 workflows 里把「构建成功 → 让桌宠跳个舞」连起来

## 数据位置（本机）

| 位置 | 内容 |
|---|---|
| `~/.dsh/dsh-pet-bridge/vendor/` | 一键安装的 dsh-pet 本体（npm 布局） |
| `~/.dsh/dsh-pet/` | dsh-pet 自己的配置与运行状态（官方目录） |
| `~/.dsh/electron/` | 桌宠窗口的 Electron 运行时（官方自动下载） |

## 开发

```sh
# 冒烟：真实走完 安装识别→启动握手→API 转发→优雅关停（需已装 dsh-pet）
E:/Github_Pro/orbit-tools/node_modules/.bin/electron tools/smoke.js
E:/Github_Pro/orbit-tools/node_modules/.bin/electron tools/smoke.js --adopt <dsh-pet包目录>

# 面板截图（浅/深主题，--live 真实拉起桌宠）
E:/Github_Pro/orbit-tools/node_modules/.bin/electron tools/panel-shot.js --adopt <dir> --live
```

## 许可与致谢

- 本桥接插件代码：MIT（© 2026 Ikaros-521）
- dsh-pet 本体（由你从 npm 安装，不在本仓库内）：代码 MIT © PC2005-cloud；
  **鲸鱼娘形象与动画素材：CC BY-NC-SA 4.0，禁止商用**，原作者与二创声明见
  [dsh-pet 仓库](https://github.com/PC2005-cloud/dsh-pet)
- 深谢 [PC2005-cloud/dsh-pet](https://github.com/PC2005-cloud/dsh-pet)：独立模式（伪 ctx + 本机路由接管）
  的设计让这次移植得以零修改完成
