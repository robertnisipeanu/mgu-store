# mgu-store

[English](README.md) | 简体中文

适用于宝马 iDrive 7 和 iDrive 8 车机（MGU）的应用商店。可以直接在车机屏幕上，
浏览、安装、更新和移除来自 GitHub 仓库、网址或 U 盘的应用。

安装内容包括：

- **应用商店**：车机上的商店应用；
- **更新器**：按商店的请求下载和安装组件；
- **部署工具**：执行安装，并支持回滚；
- **应用隐私**：防止已安装的应用出现在车机向宝马发送的报告中；
- **渲染器**：绘制商店和其他应用的图形界面；
- **Python**：供需要在车机上从源码构建的应用使用；
- **互联网连接组件**：通过 USB 网卡、LTE 上网卡、手机共享网络或 Wi-Fi 联网。

iDrive 8 目前仅在模拟器中测试，尚未经过实车验证。iDrive 8 上的安装和移除操作
会在下一次车机重启后生效。

## 界面截图

以下为商店界面代码使用简体中文和示例数据生成的图片，并非实车拍摄。
示例中的应用、版本和状态不代表当前发布目录。生成方式见
[截图说明](docs/screenshots/README.md)。

应用商店：查看各个来源中的应用和车机工具。

![简体中文应用商店，展示应用、工具及安装状态](docs/screenshots/store.zh-CN.png)

应用详情：查看应用来源、版本和可执行的操作。

![简体中文应用详情，展示版本、来源和更新操作](docs/screenshots/app.zh-CN.png)

已安装：查看车机上的应用和工具。

![简体中文已安装页面，展示应用、工具及其版本](docs/screenshots/installed.zh-CN.png)

设置：管理来源、Wi-Fi、账号和手机访问。

![简体中文设置页面，展示来源和访问设置](docs/screenshots/settings.zh-CN.png)

添加 GitHub 仓库：选择发行版、标签或分支。

![简体中文添加来源页面，展示可选的发行版和分支](docs/screenshots/add-source.zh-CN.png)

## 使用条件

- 一台 Windows 10/11、macOS 或 Linux 电脑（x64 或 arm64），
  配备 OpenSSH 客户端，这三个系统均内置该客户端。
- 车机的 root SSH 访问权限及对应私钥。可以使用
  [idrive7-8-ssh-root](https://github.com/cauliflowermossgrape/idrive7-8-ssh-root)
  等工具，通过 ENET 线设置。
- 可连接车机 SSH 的网络：车载 Wi-Fi 热点（默认地址 `172.16.222.97`）、
  ENET 或其他 SSH 连接方式。
- 车辆停稳，并在安装完成前保持稳定供电。

## 安装

将电脑连接到车机（车载 Wi-Fi 热点或 ENET 线），然后指定 root 的 SSH 私钥运行安装器：

```sh
# macOS, Linux
curl -fsSL https://raw.githubusercontent.com/robertnisipeanu/mgu-store/main/deploy/install.sh | sh -s -- first-install --identity ~/.ssh/mgu_root_key
```

```powershell
# Windows PowerShell
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/robertnisipeanu/mgu-store/main/deploy/install.ps1))) first-install --identity $HOME\.ssh\mgu_root_key
```

安装器会自动查找车机，并显示所使用的连接方式。下文的其他命令
（`token`、`usb-repo`、`first-install --from`）也可以用相同方式运行，
替换上述命令中的 `first-install …` 即可。

安装器询问 `Restart the head unit now? [y/N]` 时，输入 `y` 重启车机。
之后，商店图标会出现在车机应用列表中，后续更新均可通过商店完成。

| 参数 | 作用 |
|---|---|
| `--identity <file>` | root 的 SSH 私钥 |
| `--host <address>`、`--port <n>` | 指定车机 SSH 地址，未指定端口时使用 22；使用 SSH 配置别名时，通过 `--port` 指定其端口 |
| `--user <name>` | SSH 用户名，默认为 `root` |
| `--ssh-opt <option>` | 附加的 `ssh -o` 选项，例如 `ConnectTimeout=30`，可多次指定。通过跳板机连接时也需指定 `--host`：`--host <head unit> --ssh-opt ProxyJump=<jump host>` |
| `--token` | 提示输入用于访问私有仓库的 GitHub 令牌 |
| `--no-uplink` | 不安装互联网连接组件 |
| `--no-renderer` | 不安装渲染器 |
| `--no-restart-prompt` | 结束时不询问是否重启车机 |

如果电脑已安装 [Node.js](https://nodejs.org) 18 或更高版本，也可以直接运行脚本：

```sh
curl -fsSL https://raw.githubusercontent.com/robertnisipeanu/mgu-store/main/deploy/mgu-install.js | node - first-install --identity ~/.ssh/mgu_root_key
```

```powershell
irm https://raw.githubusercontent.com/robertnisipeanu/mgu-store/main/deploy/mgu-install.js -OutFile mgu-install.js; if ($?) { node mgu-install.js first-install --identity $HOME\.ssh\mgu_root_key }
```

## 卸载

将安装器命令中的 `first-install` 替换为 `uninstall`，即可移除商店：

```sh
# macOS, Linux
curl -fsSL https://raw.githubusercontent.com/robertnisipeanu/mgu-store/main/deploy/install.sh | sh -s -- uninstall --identity ~/.ssh/mgu_root_key
```

```powershell
# Windows PowerShell
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/robertnisipeanu/mgu-store/main/deploy/install.ps1))) uninstall --identity $HOME\.ssh\mgu_root_key
```

安装器会列出通过商店安装的应用和工具（包括其他仓库的工具），并询问
`Remove all of it? [y/N]`，也可用 `--yes` 自动确认。随后会移除这些内容、
安装过程对车机所作的更改，以及商店设置和令牌。

结束时会显示是否还有残留；再次运行可继续清理。需要重启才能完成时，
会询问 `Restart the head unit now? [y/N]`。卸载使用相同的车机发现方式，
并支持相同的 SSH 参数（`--identity`、`--host`、`--port`、`--user`、`--ssh-opt`）。

## 使用商店

侧边菜单包含四个页面：

- **应用商店**：展示来源中的应用和工具，以及已安装、可更新、待重启等状态。
- **已安装**：查看已安装的内容，使用**更新**或**全部更新**。
- **USB**：查看插入的 U 盘中的内容。
- **设置**：管理来源、Wi-Fi、账号、代理和手机访问，也可**检查更新**或**重启主机**。

打开应用或工具即可安装、更新或移除。更新不会自行安装。
标记为待重启的工具需要重启车机后才能生效（设置 → **重启主机**）。

### 来源

商店预置以下来源：本仓库、
[idrive7-apps](https://github.com/cauliflowermossgrape/idrive7-apps)、
[idrive-apps](https://github.com/robertnisipeanu/idrive-apps)
（包含仪表盘和 HUD 渲染器，以及仪表盘 CarPlay 地图），以及
[car-apps](https://github.com/IterioDev/car-apps)
（IterioDev 的应用和工具，大部分仅适用于 iDrive 8，跟踪最新的 x.y.z 标签）。

添加来源：设置 → **添加来源**，输入 `owner/repo`、GitHub 链接，
或 `catalog.json` 的 `https://` 地址。对于 GitHub 仓库，
可根据仓库提供的内容，选择跟踪**发行版**、**标签**或某个分支。

在 iDrive 8 上，使用 mgu-render 绘制商店时，添加来源和添加令牌会打开
商店的屏幕键盘。未使用 mgu-render 的原生控件界面目前尚不支持 iDrive 8 输入；
可通过手机页面或电脑添加来源和令牌，也可以使用 **GitHub 登录**。

### 私有仓库

在设置 → **账号**中添加账号：

- **GitHub 登录**：扫描二维码，在手机上输入代码并登录。
  对应仓库还需要安装 [mgu-store GitHub App](https://github.com/apps/mgu-store)。
- **添加令牌**：输入 GitHub 令牌。相比车机，使用手机页面，
  或在电脑上运行 `node mgu-install.js token --identity <key>` 输入更方便。

**创建令牌：**

1. 打开 github.com，依次进入头像 → **Settings** → **Developer settings** →
   **Personal access tokens** → **Fine-grained tokens** → **Generate new token**。
2. 输入名称并设置有效期；选择 *No expiration* 可避免令牌到期后车机无法继续访问。
3. **Resource owner**：选择你的账号或仓库所属组织，一个令牌对应一个所有者。
4. **Repository access**：选择 **Only select repositories**，
   勾选车机需要读取的私有仓库。
5. **Permissions**：添加 **Contents**，权限设为 **Read-only**。
6. 点击 **Generate token** 并复制令牌（`github_pat_…`）；GitHub 只显示一次。

组织可能需要先批准令牌。访问其他人账号下的仓库时，改用带有 `repo` 权限范围的
classic token。

### 手机页面

设置 → **手机访问** → 开启后会显示二维码。手机连接车载热点后扫码，
即可查看来源、安装状态、错误和日志，也能使用手机键盘添加来源和账号。
使用完毕后关闭手机访问。

### 联网

互联网连接组件可为更新器和需要联网的应用提供以下连接方式：

- USB 以太网适配器；
- LTE 上网卡，例如 Huawei E3372h；
- 开启 USB 网络共享的 Android 手机；
- 开启个人热点并保持解锁的 iPhone，出现提示时点击**信任**；
  共享网络期间，iPhone 的 USB 音乐播放会停止；
- Wi-Fi，例如手机热点：设置 → **Wi-Fi**。
  车载热点和无线 CarPlay 仍可同时使用。
  配备 Broadcom 无线网卡的 iDrive 7 车机无法连接仅支持 WPA3 的网络。

连接成功后，商店会显示在线状态。

### 代理

如果访问 GitHub 缓慢或受阻，更新器可以通过同一网络中的代理下载，
例如电脑或路由器上的 Clash。在设置 → **代理**中开启代理并填写地址，
例如 `http://192.168.8.1:7890` 或 `socks5://192.168.8.1:7891`。
需要密码的代理可使用 `socks5://user:password@192.168.8.1:7891`。
更新器的所有下载，以及车机上的构建过程，都会使用该代理。
关闭后恢复直接下载。手机页面也提供相同设置。

## 离线使用：U 盘

车机没有互联网连接时，可以通过 U 盘安装和更新。在电脑上运行：

```sh
node mgu-install.js usb-repo <stick> [github:owner/repo | <catalog URL> | <folder> | <package file> ...]
```

不指定输入来源时，会复制本仓库的最新发行版。将 U 盘插入车机后，
在商店的 **USB** 页面中操作。

尚未安装商店的车机，也可以使用同一文件夹进行安装，无需车机联网：

```sh
node mgu-install.js first-install --from <stick>/mgu-repo/mgu-store --identity <key>
```

## 发布自己的应用

GitHub 仓库或 HTTPS 地址均可作为来源，支持三种组织方式：

| 方式 | 内容 |
|---|---|
| Releases | 将构建好的 `<id>@<version>.tgz`（或 `.mgu`）包作为 GitHub Release 附件发布 |
| Catalog | 用 `catalog.json` 列出各个包，放在名为 `catalog` 的 Release 中，或任意 HTTPS 地址上 |
| Repo tree | 提供 `mgu-repo.json`，由车机从源码构建应用 |

每个应用需要满足：

- **不包含宝马 SDK 文件。** 车机会将应用与已有 SDK 链接。
- **唯一且带前缀的 id**，例如 `acme_gauges`。
- **`mguHmi`**：填写 `["ID7"]`、`["ID8"]` 或同时支持两者。
- **`requires`**（可选）：声明依赖的组件，安装时先安装依赖。
- 需要联网时，在 `package.json` 中设置 **`"mguInternet": true`**。

完整指南和示例见 [docs/PUBLISHING.md](docs/PUBLISHING.md)。

## 开发

各组件的 README 分别介绍构建和测试方法。
[`deploy/README.md`](deploy/README.md) 包含完整安装器参考
（包括 `token --list` / `--remove` 等命令），以及从本地源码安装组件的 `deploy/hu`；
[`release/README.md`](release/README.md) 介绍发布流程。
PR 中的版本号、CHANGELOG 条目和 `requires` 规则见
[`CONTRIBUTING.md`](CONTRIBUTING.md)。

## 许可证

Copyright (C) 2026 Robert Nisipeanu and IterioDev。采用 GPL-3.0-or-later
（`LICENSE`）。第三方组件保留各自的许可证，详见 `THIRD_PARTY_NOTICES.md`。
