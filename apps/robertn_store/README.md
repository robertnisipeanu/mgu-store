# robertn_store 0.9.1

The Store: every app and head-unit tool of every source, each with its
state, the progress of the running install, the sources and the phone page.
It is the screen of [mgu-updater](../../native/mgu-updater/README.md),
which does all the work; the app shows the state the updater streams over
its socket and sends it requests: check, install and reboot, and the
privileged ones (uninstall, source-add, source-probe, source-remove, token-add, token-remove,
login-start, login-cancel, web), which carry the secret the updater leaves in the app's data folder
(`data/updater-secret`, read again for every request). It is for iDrive 7
and iDrive 8 (`mguHmi`).

## Two sets of screens

**Drawn by [mgu-render](../../native/mgu-render/README.md)** while it runs
and speaks its own protocol (mgu-render/1), through its own socket (beside
any other renderer installed, which draws its own apps): IterioDev's App Manager 2
screens (his [mgu-app-store](https://github.com/IterioDev/mgu-app-store)
`apps/oap-appmanager`: the screens, their widgets and the kit they are
drawn with, `src/am_*.js` and `src/kit_*.js`), fed from the updater's state
(`src/store_ui.js`). A side menu (Store, Installed with its update count,
USB, Settings) beside:

- **Store**: All / Apps / Tools, Online / Offline / Checking, the status line
  (or the running install), a grid of tiles: the package's picture when the
  updater names one (`components[].icon`, a PNG file), else a letter tile
  (round for a tool), its state (`Installed`, `Update 1.0.1`, `Downloading
  42 %`, `Waiting`, `Not for this head unit`, `Failed`, `Restart pending`,
  version and size) and a badge or progress ring. A version not for this
  head unit is not counted as an update.
- **A component's page**: picture, name, author and source, Version, Commit, size, `Id
  <id>` (an app installed under another id than its source's), App
  or Tool, its head units and capability, the description; Installed and
  Available; the running phase (Downloading, Verifying, Building,
  Installing, Removing) with its progress; `Not installable` and why (a package of an id another source's app
  holds; installed, it shows as installed, with Remove and no update), `Not for this head unit` / `For
  iDrive 8` (that version is not offered), the failure, `Restart pending`; and what can be done:
  Install, Update to, Try again, Restart head unit, Remove (a confirm step). A second renderer
  installs beside the first.
- **Installed**: apps and head-unit tools, each with its update (a press on
  Update installs it) or state, and Update all.
- **USB**: the components of the sticks' sources.
- **Settings**: the sources (each opens its page: channel, account,
  components, error, Remove with a confirm step, and while a sign-in does
  not reach a private one the GitHub App's install page as a QR code and
  its address), Add source, Accounts (each one's Remove with a confirm
  step; Sign in with GitHub while `state.signin` is true; Add token), Phone
  access, the head unit and versions, Check now, Restart head unit.

Confirm steps are a sheet over the page, Cancel first. Every page is a host
state of the next depth (`ST_OnlineApps_StoreLayer1..3`, on iDrive 7 also
`ST_OnlineApps_StoreEmbed1..3` on the renderer's page template), so BACK
leaves it. Each host state's focusable buttons stand for what the page has
to press, in focus order: the controller moves the HMI's focus over them
and the drawn page shows it as a ring; a press presses it. In embed mode,
until the HMI reports a press on one of the page template's buttons (the
emulator's HMI routes them neither focus nor presses), the dial and push come from
FrontCCU (`statusRotaryEncoderState`, the manifest's proxy) while the page
has the HMI's focus, and move the ring themselves. A page's focus
starts on what it is for, a tab's on the side menu. Touch in the box goes
to the drawn items; a drag scrolls a grid or list. With the HMI's
controller gate loaded (the renderer's `controller`), the dial and push
come straight from the renderer instead.

The screens are drawn at most 30 times a second (the renderer's frame
cap) into the renderer's box: embed (inside the page, iDrive 7 once the
template is loaded) or layer (over the page, on the app area). On iDrive 8
they are App Manager 2's design (2880 x 960) scaled into the box; on
iDrive 7 (a box under 700 px high) `src/store_compact.js` lays the same
screens out for the box itself at full size. Text is
Inter (SIL OFL, `src/LICENSE-Inter.txt`), baked by `tools/bake_fonts.py`;
the atlases are at most 1024 px wide and use about a quarter of the
renderer's glyph texture, which all apps share. Nothing from the HMI is
drawn: icons are the kit's vector icons or package pictures.

**The HMI's own widgets** (below) whenever the renderer is not there, not
yet answering at start (1.5 s), or gone (the Store installs or updates it):
the Store moves to them at once and back once the renderer answers again,
and the tile opens whichever set is in use (`mapEntryState`). The HMI keeps
the entry state of the set left, so after such a switch BACK passes
through it once. iDrive 8 has its own widget layout
(`uiDescriptions/ID8`, `LT_State_Wide_List` with
`LT_Button_MediaEntry_1Row` rows) and no embed host states.

On iDrive 8 the deploy tool gives the Store the id its tile needs when it
installs it; the same package runs on iDrive 7.

## The widget screens

| Row (`LT_Button_1Row_2Col7030_2Text`) | Press |
|---|---|
| `DOOM` · `Update 1.0.1` | update to the catalog version |
| `Gauges` · `Update a1b2c3d` | update to a branch's new commit (same version, new revision) |
| `Display bridge demo` · `Install 1.0.0` | install |
| `Network driver` · `Install 0.2.0` | install (an optional component) |
| `Vehicle control` · `Installed 1.0.0` | nothing; *Remove?* when the catalog marks it `uninstallable` |
| `DOOM` · `42%` / `Verifying` / `Building` / `Installing` / `Removing` | nothing (in progress) |
| `Extended dashboard` · `Waiting` | nothing (queued) |
| `Display bridge` · `Restart pending` | nothing (installed; active after the next reboot) |
| `Car Data` · `Not for this head unit` | nothing (the updater marks that version `compat: "no"`); *Remove?* for an installed, `uninstallable` one |
| `DOOM` · `Failed, retry` | try again (the status line names the error) |
| `Renderer` · `Install 0.2.0` | install it (beside another installed renderer) |

The start screen has a status line (`1 update, checked 14:02`, `Offline`,
`Checking for updates`, `Restarting`, the last error; `Restart the head
unit to finish setup` while the updater has not run since the Store was
installed, which after the first install is until the next start; `Updater
not running` once it has), a **Check for updates** button, a progress bar for the running
install (hidden when none runs), the rows **Apps** and **Head-unit tools**,
each showing its running install, `Failed` or its number of updates,
**Sources** (`Sign in` or `Error` when a source needs it), **Phone access**
(`On` / `Off`), and **Restart head unit**. Apps and Head-unit tools each
open their own list of the rows above, one row per component the updater
lists. Opening the Store also asks for a check. Sources and Phone access
are hidden with an updater that reports no `sources` or `web`.

**Remove?** names the component (`DOOM 1.0.1`) and has **Cancel** and
**Remove**, which asks the updater to uninstall it.

**Restart head unit** opens a confirm step, *Restart head unit?*, with
**Cancel** (focused first) and **Restart**. Restart asks the updater to
restart the head unit through the Node State Manager (its `reboot`
request). The row is hidden
while an install runs or waits, while the updater is unreachable or
already restarting the unit, and with an updater older than 0.1.4.

## Sources

**Sources** has a status line (a source typed wrong, the updater's refusal
to add or remove one, a speller that could not open; hidden otherwise),
one row per source, its label and the account that reads it (a GitHub
login), else its status: `OK`, `USB` (a source on a plugged-in USB stick),
`Checking`, `Sign in` (no account reaches it), `Error`, `Offline`; then
**Add source**, **Accounts** and **Phone access** (the phone page, for
pasting tokens and for logs). A source's page shows its label and status,
**Channel** (`Releases`, `Branch <name>`, `Tags`), **Account** (the GitHub
login that reads it), **Components** (how many it lists), its error and
**Remove** (with a confirm step, *Remove source?*; not for the Store's own
source or a USB source).

**Accounts** are the updater's tokens, which belong to no source: the
updater reads each source with whichever one reaches it, so one account
serves every repo it can read and a source added later needs nothing more.
The row shows the account (one), `<n> accounts` or `None`; hidden with an
updater that reports no `tokens`. Its page has a status line (Add token's:
`Checking token`, `Added <account>`, `Add token failed: …`; hidden
otherwise), lists each account, its label (else its login, else its id)
and the sources it reads (`2 sources`, `Unused`, `Rejected` when GitHub
refuses it), then **Sign in with GitHub** and **Add token**. Pressing an
account opens *Remove account?*: its name, the sources it reads, **Cancel**
and **Remove** (`token-remove`).

**Add token** opens the speller, titled *GitHub token*; the text confirmed
with OK, trimmed, goes to the updater as `token-add`. The updater asks
GitHub whose token it is before storing it: the status line says
`Checking token` meanwhile, then `Added <account>` once the account
appears, or the updater's refusal. A token the updater already has adds no
account; the status line clears after 30 s.

**Sign in with GitHub** starts the updater's GitHub device sign-in, which
adds an account, and opens its page: **Cancel** (first, so its focus
scrolls nothing away), the QR code of the sign-in page with the code drawn
large beside it, the code and the page's address as text, and the status
(`Waiting for sign-in`, `Code expired`, `Sign-in failed: …`). The page
closes itself once signed in.

**Add source** opens the HMI's own full-screen speller (`src/speller.js`,
the free-text speller use case `02076b22-…` that x_call uses; the
manifest's usecasemanagement proxies let the app open it), titled *Add
source*. The text confirmed with OK, trimmed, is:

- `owner/repo`, or a repo's address on github.com (`github.com/owner/repo`,
  `https://github.com/owner/repo`, with or without `.git` or a trailing
  slash): a GitHub repo. `…/tree/<branch>` adds it at once with `source-add`
  `type: "github"`, `repo`, `channel: "branch:<branch>"`. Without a branch
  the status line says `Checking <repo>` while the updater is asked what the
  repo has (`source-probe`); then the repo's page (below) opens, or a repo
  with only one choice is added on it, one with none without a channel, or
  the status line says why not (`Add source failed: Offline`, `GitHub rate
  limit reached`, `… is already a source`, `the updater did not answer`
  after 30 s, `updater not running` when it goes away). With an updater before 0.7.0 the repo is added without a
  channel.
- any other `https://host/path` address (the scheme in any case), a
  catalog: `source-add` with `type: "https"`, `url`.
- anything else, a github.com address that is not a repo's included:
  `Not owner/repo or https://host/path: …` on the status line.

The updater's refusal (`… is already a source`) shows on the status line.

**A repo's page** (`ST_OnlineApps_StoreSourcePick`; the drawn `pick`
page) has the repo as its status line (or title), then one row per
choice, only those the repo has: `Releases`, `Tags`, then each branch
(`Branch`, `Default branch`), main and master first, then the default
branch, then the rest. A press adds the repo on it (`source-add` with
`channel` `releases`, `tags` or `branch:<name>`, and `repo` as GitHub
spells it, the probe's `name`) and closes the page. A
repo no account reaches shows `Not found or private`, **Sign in with
GitHub** and **Add token** (the status of an Add token pressed there
shows on the page until the repo's next answer); once the accounts change
it is asked about again and lists its choices, or, with none, is added
without a channel. A failure on the page shows with **Try again**. BACK
from the page ends the adding. The page opens only once the HMI has
given the focus back from the speller (or 2 s after it closed), since the
focus coming back below a page opened earlier closes it.

Leaving the speller without OK, or OK with nothing typed, sends nothing. A
USB stick holding a catalog or a repo tree appears in the list by itself
([mgu-updater](../../native/mgu-updater/README.md)).

## Phone access

**Phone access** turns the updater's phone page on or off (`On` / `Off`)
and, while on, shows the QR code of the page's access URL (with its token)
and the URL as text, and the page's error. The updater leaves the access
URL in the app's data folder (`data/web-url`, one line, owner the app's
uid, 0400) while the page is on; it is read again on every render, and
every second while Phone access is open and on. Without it the page shows
no QR code, only the token-free address the state reports (`web.urls[0]`)
as text.

QR codes are written to `/dev/shm/robertn_store_qr_<uid>/` (0755, files
0644), where the HMI can read them, a new file per text, and removed when
replaced, when their page has nothing to show, and at start and shutdown.
Neither the sign-in code, the phone page's address nor the secret goes into
a log line.

An app installs or updates in place when the running MainApp can do it:
only that app stops and starts. Otherwise the installer restarts MainApp's
app processes, the Store included (deploy/README.md, "In place"). When the
Store closes this way, or is the app being updated, the updater carries
on, and the Store shows the result when it is opened again.

## Layout

```
mgu-app.json               the source package's manifest: tree, modules (bundle ids from 10000 in this order), oap-sdk names
src/store.js               the app: updater client, widget screens, which set of screens shows
src/store_view.js          the texts from the updater's state (both sets of screens)
lib/client.js              mgu-updater's socket client, copied by tools/build.js
src/qr.js, src/qrcodegen.js  QR codes (Project Nayuki's generator 1.5.0, src/LICENSE-qrcodegen.txt)
src/speller.js             the HMI's free-text speller
src/store_drawn.js         the drawn screens: renderer connection, placement, pages, host states, proxies, touch, pictures
src/store_frame.js         one frame: the screen, its values, what can be pressed, the focus ring; the placement
src/store_compact.js       the screens laid out for iDrive 7's box
src/store_ui.js            the drawn screens' values from the updater's state
src/store_elements.js      the Store's own element: QR code
src/am_screens.js          the screens (App Manager 2's screens.json, with the Store's pages)
src/am_gpu.js, src/am_elements.js, src/am_widgets.js, src/am_store_widgets.js
                           App Manager 2's element drawing (no gauges, no HMI icon atlas)
src/kit_*.js               the kit: record, canvas, vicons, png, themes (MIT, src/LICENSE-kit.txt);
                           kit_fonts.js maps its families onto Inter
src/font_regular.js, src/font_semibold.js   Inter glyph atlases (tools/bake_fonts.py)
lib/mgu_render_client.js   mgu-render's client, copied by tools/build.js
tools/gen_rhmi.js          application.xml + uiDescription.json for iDrive 7 and 8 from one table
tools/build.js             RHMI, lib/, the source package, and given a donor the OAP tgz
tools/bake_fonts.py        the Inter atlases (Pillow, Inter 4.1's TTFs)
tools/gen_screens.py       src/am_screens.js from App Manager 2's screens.json
tools/fixture.js           an updater state with one of everything, and the drawn screens over it
tools/test_view.js         the texts for every row, source, account, sign-in and phone state
tools/test_rhmi.js         both HMIs' RHMI files, host states and proxies, the names src/store.js binds
tools/test_qr.js           the QR pictures (decoded back with zbarimg when installed)
tools/test_speller.js      src/speller.js against a fake use case factory
tools/test_screens.js      every drawn screen in iDrive 7's and 8's boxes: in the box, values, presses, focus order, scrolling, touch
tools/test_store.js        src/store.js's flows against stand-in SDK, RHMI, updater, speller and renderer
tools/shots.js             screenshots of the drawn screens through mgu-render --replay
tools/make_icon.py         the 140x140 tile icon
robertn_store@0.9.1/       staged package tree (no javascript/: the build writes it)
```

## Build

```sh
cd apps/robertn_store
node tools/build.js                                # robertn_store@0.9.1.src.tgz
node tools/build.js --sdk <donor .tgz|.js>         # and robertn_store@0.9.1.tgz (MGU_SDK_DONOR)
node tools/test_view.js && node tools/test_rhmi.js && node tools/test_qr.js && node tools/test_speller.js &&
    node tools/test_screens.js && node tools/test_store.js && STORE_HMI=ID8 node tools/test_store.js
(cd ../../native/mgu-render && make test) && node tools/shots.js <out dir>     # screenshots
```

The published artifact is the source package: `mgu-app.json`, the modules
and the staged tree. The deploy tool on the unit links it against the
oap-sdk of an app already there and installs the result
(deploy/README.md, "Source packages"); the folder itself is that package,
so a source following a branch builds it straight from a checkout
(`mgu-repo.json`). With a donor on the build machine (an OAP app's tgz or
`javascript/app.js`, never committed) the build writes the same OAP tgz
the unit builds, for the emulator: the modules linked against the donor's
oap-sdk modules with its module ids, the donor package's own entry point
as `javascript/runner.js` (the package's `main`) with a `runnerConfig.json`
naming the bundle and data folder, `node --check`, `javascript/build.json`.
`lib/client.js` and `lib/mgu_render_client.js` are committed: run the build
after `native/mgu-updater/js/client.js` or
`native/mgu-render/js/mgu_render_client.js` changes and commit the copies.
The Store requires mgu-render (`release.json`), so an install puts it on.

## Needs the head unit

- iDrive 7: whether the HMI routes focus and presses to the page
  template's buttons, else FrontCCU's dial and push there; touch inside the
  page template; the compact layout's text and buttons for reading and
  pressing in the car.
- iDrive 8: the widget layout (`LT_State_Wide_List`, `LT_Button_MediaEntry_1Row`
  cells, the QR picture label), the layer host states' proxies and focus
  events, `mapEntryState` switching, the manifest's proxies under MainApp-21,
  the entry point's insertion there.
