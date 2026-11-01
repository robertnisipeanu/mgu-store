# mgu-store

An app store for BMW iDrive 7 and iDrive 8 head units (MGU). Browse,
install, update and remove apps on the car's screen, from GitHub
repositories, web addresses or a USB stick.

It installs:

- the **Store** app;
- the **updater**, which downloads and installs what the Store asks for;
- the **deploy tool**, which performs and can roll back every install;
- **app privacy**, which keeps installed apps out of the head unit's reports to BMW;
- the **renderer**, which draws the Store and other apps' graphics;
- **Python**, for apps the head unit builds from source;
- the **internet uplink**, for internet through a USB adapter, an LTE stick, a tethered phone or Wi-Fi.

iDrive 8 is tested in an emulator only, not yet on a real car. On iDrive 8,
installs and removals take effect at the next head-unit restart.

## Screenshots

The Store: apps and head-unit tools from every source.

![The Store page, listing installed tools and the apps available from the sources](docs/screenshots/store.png)

An app's page, with its source, version and Install.

![The page of the Drag Timer app, with its version, source and an Install button](docs/screenshots/app.png)

Installed: the apps and tools on the head unit.

![The Installed page, listing the installed apps and head-unit tools with their versions](docs/screenshots/installed.png)

Settings: sources, Wi-Fi, accounts and phone access.

![Settings, with the default sources, Wi-Fi, Accounts and Check now](docs/screenshots/settings.png)

Adding a GitHub repository: pick its releases, tags or a branch.

![Adding a GitHub repository as a source, offering Releases, Tags and its branches](docs/screenshots/add-source.png)

## Requirements

- A computer (Windows 10/11, macOS or Linux, x64 or arm64) with the
  OpenSSH client, which all three have built in.
- Root SSH access to the head unit and root's private key. Tools such as
  [idrive7-8-ssh-root](https://github.com/cauliflowermossgrape/idrive7-8-ssh-root)
  set it up over an ENET cable.
- A way to reach the head unit's SSH: the car's Wi-Fi hotspot (default
  address `172.16.222.97`), ENET, or any other SSH route.
- The car parked and on stable power until the install finishes.

## Install

Connect the computer to the head unit (the car's Wi-Fi hotspot or an ENET
cable), then run the installer with root's SSH key:

```sh
# macOS, Linux
curl -fsSL https://raw.githubusercontent.com/robertnisipeanu/mgu-store/main/deploy/install.sh | sh -s -- first-install --identity ~/.ssh/mgu_root_key
```

```powershell
# Windows PowerShell
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/robertnisipeanu/mgu-store/main/deploy/install.ps1))) first-install --identity $HOME\.ssh\mgu_root_key
```

It finds the head unit by itself and says which connection it used.
The other commands below (`token`, `usb-repo`, `first-install --from`) run
the same way, in place of `first-install …` in the one-liner.
Restart the head unit when the installer asks. The Store's tile then
appears among the car's apps, and every later update comes through the
Store.

| Option | What it does |
|---|---|
| `--identity <file>` | root's private SSH key |
| `--host <address>`, `--port <n>` | reach the head unit at this SSH address instead (port 22 unless given); for an SSH config alias, give its port with `--port` |
| `--user <name>` | SSH user (default `root`) |
| `--ssh-opt <option>` | an extra `ssh -o` option, e.g. `ConnectTimeout=30`; repeatable. Through a jump host, give `--host` too: `--host <head unit> --ssh-opt ProxyJump=<jump host>` |
| `--token` | asks for a GitHub token, for private repositories |
| `--no-uplink` | leaves out the internet uplink |
| `--no-renderer` | leaves out the renderer |

With [Node.js](https://nodejs.org) 18 or newer, the installer also runs as
a script:

```sh
curl -fsSL https://raw.githubusercontent.com/robertnisipeanu/mgu-store/main/deploy/mgu-install.js | node - first-install --identity ~/.ssh/mgu_root_key
```

```powershell
irm https://raw.githubusercontent.com/robertnisipeanu/mgu-store/main/deploy/mgu-install.js -OutFile mgu-install.js; if ($?) { node mgu-install.js first-install --identity $HOME\.ssh\mgu_root_key }
```

## Using the Store

The side menu has four pages:

- **Store**: apps and tools from your sources, with their state (installed,
  update available, restart pending, …).
- **Installed**: what is installed, with **Update** and **Update all**.
- **USB**: what a plugged-in USB stick offers.
- **Settings**: sources, Wi-Fi, accounts, phone access, **Check now** and
  **Restart head unit**.

Open an app or tool to install, update or remove it. Updates never install
on their own. Tools marked *Restart pending* take effect after a head-unit
restart (Settings → **Restart head unit**).

### Sources

The Store comes with these sources: this repository,
[idrive7-apps](https://github.com/cauliflowermossgrape/idrive7-apps),
[idrive-apps](https://github.com/robertnisipeanu/idrive-apps) (with the
renderer that draws on the instrument cluster and the HUD, and the CarPlay
map on the instrument cluster) and
[car-apps](https://github.com/IterioDev/car-apps) (IterioDev's apps and
tools, most of them for iDrive 8 only, at its newest x.y.z tag).

To add one: Settings → **Add source**, then type `owner/repo`, a GitHub
link, or the `https://` address of a `catalog.json`. For a GitHub
repository, pick what to follow from what it has: **Releases**, **Tags** or
one of its branches.

On iDrive 8, Add source and Add token open the Store's on-screen keyboard
while mgu-render draws the Store. On the Store's widget screens (no
mgu-render), typing doesn't work yet on iDrive 8: add sources and tokens
from the phone page or the computer, or use **Sign in with GitHub**.

### Private repositories

Add an account in Settings → **Accounts**:

- **Sign in with GitHub**: scan the QR code, enter the code on your phone
  and sign in. The repository also needs the
  [mgu-store GitHub App](https://github.com/apps/mgu-store) installed.
- **Add token**: a GitHub token. Typing it on the phone page or with
  `node mgu-install.js token --identity <key>` on the computer is easier
  than on the car.

**Creating a token:**

1. On github.com: your picture → **Settings** → **Developer settings** →
   **Personal access tokens** → **Fine-grained tokens** →
   **Generate new token**.
2. Name it, and pick an expiration (*No expiration* keeps the car working).
3. **Resource owner**: your account, or the organisation that owns the
   repositories. One token covers one owner.
4. **Repository access**: **Only select repositories**, and pick the private
   repositories the car should read.
5. **Permissions**: add **Contents**, set to **Read-only**.
6. **Generate token** and copy it (`github_pat_…`); GitHub shows it once.

An organisation may have to approve the token first. For a repository of
someone else's account, use a classic token with the `repo` scope instead.

### Phone page

Settings → **Phone access** → **On** shows a QR code. Scan it with a phone on the
car's hotspot to see sources, installs, errors and logs, and to add sources
and accounts with the phone's keyboard. Turn it off when done.

### Internet

The internet uplink gives the updater and apps that need it internet
through:

- a USB Ethernet adapter;
- an LTE stick (e.g. Huawei E3372h);
- an Android phone with USB tethering;
- an iPhone with Personal Hotspot on, kept unlocked (tap **Trust** when
  asked); its USB music playback stops while it tethers;
- Wi-Fi, such as a phone's hotspot: Settings → **Wi-Fi**. The car's own
  hotspot and wireless CarPlay keep working beside it. On iDrive 7 units
  with a Broadcom radio, WPA3-only networks can't be joined.

The Store shows `Online` once connected.

## Offline: USB stick

A car without internet installs and updates from a USB stick. On the
computer:

```sh
node mgu-install.js usb-repo <stick> [github:owner/repo | <catalog URL> | <folder> | <package file> ...]
```

Without inputs it copies this repository's newest release. Plug the stick
into the car and use the **USB** page.

A car without the Store yet installs it from the same folder, with no
internet at the car:

```sh
node mgu-install.js first-install --from <stick>/mgu-repo/mgu-store --identity <key>
```

## Publishing your apps

Any GitHub repository or HTTPS address can be a source, in one of three
layouts:

| Layout | What the repository has |
|---|---|
| Releases | built `<id>@<version>.tgz` (or `.mgu`) packages attached to GitHub releases |
| Catalog | a `catalog.json` listing each package (in a release named `catalog`, or at any HTTPS address) |
| Repo tree | an `mgu-repo.json`; the head unit builds the apps from source |

Every app needs:

- **No BMW SDK files.** The head unit links apps against the SDK already on
  it.
- **A unique id**, with a prefix (`acme_gauges`).
- **`mguHmi`**: `["ID7"]`, `["ID8"]` or both.
- **`requires`** (optional): other components it needs, installed first.
- **`"mguInternet": true`** in `package.json` if it needs internet.

[docs/PUBLISHING.md](docs/PUBLISHING.md) has the full guide and examples.

## Development

Each component's README covers its build and tests.
[`deploy/README.md`](deploy/README.md) has the full installer reference
(every command, including `token --list`/`--remove`) and `deploy/hu`, which
installs components from a checkout; [`release/README.md`](release/README.md)
covers releases.

## License

Copyright (C) 2026 Robert Nisipeanu and IterioDev. GPL-3.0-or-later
(`LICENSE`). Third-party parts keep their own licences:
`THIRD_PARTY_NOTICES.md`.
