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
- the optional **internet uplink**, for internet through a USB adapter, an LTE stick or a tethered phone.

iDrive 8 is tested in an emulator only, not yet on a real car. On iDrive 8,
installs and removals take effect at the next head-unit restart.

## Requirements

- A computer (Windows 10/11, macOS or Linux) with
  [Node.js](https://nodejs.org) 18 or newer and the OpenSSH client.
- Root SSH access to the head unit and root's private key. Getting root
  access is not covered here.
- A way to reach the head unit's SSH: the car's Wi-Fi hotspot (default
  address `172.16.222.97`), ENET, or any other SSH route.
- The car parked and on stable power until the install finishes.

## Install

1. Download the installer:

   ```sh
   # macOS, Linux
   curl -LO https://raw.githubusercontent.com/robertnisipeanu/mgu-store/main/deploy/mgu-install.js
   ```

   ```powershell
   # Windows PowerShell
   Invoke-WebRequest https://raw.githubusercontent.com/robertnisipeanu/mgu-store/main/deploy/mgu-install.js -OutFile mgu-install.js
   ```

2. Connect to the head unit (hotspot, ENET or another SSH route).

3. Run the install with root's key:

   ```sh
   node mgu-install.js first-install --identity ~/.ssh/mgu_root_key
   ```

   For an address other than the hotspot's, add `--host <address>` and, if
   needed, `--port <n>`.

4. Restart the head unit when the installer asks. The Store's tile then
   appears among the car's apps, and every later update comes through the
   Store.

| Option | What it does |
|---|---|
| `--identity <file>` | root's private SSH key |
| `--host <address>`, `--port <n>` | the head unit's SSH address and port (default `172.16.222.97:22`); an SSH config alias works too, with its port given |
| `--user <name>` | SSH user (default `root`) |
| `--ssh-opt <option>` | an extra `ssh -o` option, e.g. `ProxyJump=<host>`; repeatable |
| `--token` | asks for a GitHub token, for private repositories |
| `--no-uplink` | leaves out the internet uplink |
| `--no-renderer` | leaves out the renderer |

**ENET on a Mac:** from a clone of this repository, run
`deploy/hu connect --identity <root's key>`. It finds the head unit and
keeps a relay open until Ctrl-C. In another terminal, install with
`--host 127.0.0.1 --port 2222 --ssh-opt StrictHostKeyChecking=no --ssh-opt UserKnownHostsFile=/dev/null`.

## Using the Store

The side menu has four pages:

- **Store**: apps and tools from your sources, with their state (installed,
  update available, restart pending, …).
- **Installed**: what is installed, with **Update** and **Update all**.
- **USB**: what a plugged-in USB stick offers.
- **Settings**: sources, accounts, phone access, **Check now** and
  **Restart head unit**.

Open an app or tool to install, update or remove it. Updates never install
on their own. Tools marked *Restart pending* take effect after a head-unit
restart (Settings → **Restart head unit**).

### Sources

The Store comes with two sources: this repository and
[idrive7-apps](https://github.com/cauliflowermossgrape/idrive7-apps).

To add one: Settings → **Add source**, then type `owner/repo`, a GitHub
link, or the `https://` address of a `catalog.json`. For a GitHub
repository, pick what to follow from what it has: **Releases**, **Tags** or
one of its branches.

On iDrive 8 the car has no keyboard for apps: add sources and tokens from
the phone page.

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

Settings → **Phone access** shows a QR code. Scan it with a phone on the
car's hotspot to see sources, installs, errors and logs, and to add sources
and accounts with the phone's keyboard. Turn it off when done.

### Internet

The internet uplink gives the updater and apps that need it internet
through:

- a USB Ethernet adapter;
- an LTE stick (e.g. Huawei E3372h);
- an Android phone with USB tethering;
- an iPhone with Personal Hotspot on (tap **Trust** when asked).

Phone tethering is not yet tested on a real car. The Store shows `Online`
once connected.

## Offline: USB stick

A car without internet installs and updates from a USB stick. On the
computer:

```sh
node mgu-install.js usb-repo <stick> [github:owner/repo | <catalog URL> | <folder> | <package file> ...]
```

Without inputs it copies this repository's newest release. Plug the stick
into the car and use the **USB** page.

## Publishing your apps

Any GitHub repository can be a source, in one of three layouts:

| Layout | What the repository has |
|---|---|
| Releases | built `<id>@<version>.tgz` packages attached to GitHub releases |
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
[`deploy/README.md`](deploy/README.md) covers `deploy/hu`, which installs
components from a checkout; [`release/README.md`](release/README.md)
covers releases.

## License

MIT (`LICENSE`). Third-party parts keep their own licences:
`THIRD_PARTY_NOTICES.md`.
