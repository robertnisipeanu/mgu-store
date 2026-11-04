# robertn_store 0.9.19

The Store: every app and head-unit tool of every source, each with its
state, the progress of the running install, the sources, the phone page
and the uplink's Wi-Fi.
It is the screen of [mgu-updater](../../native/mgu-updater/README.md),
which does all the work; the app shows the state the updater streams over
its socket and sends it requests: check, install and reboot, and the
privileged ones (uninstall, source-add, source-probe, source-remove, token-add, token-remove,
login-start, login-cancel, web, and uplink-prefer, wifi-enable, wifi-scan, wifi-connect,
wifi-forget, which the updater relays to [mgu-uplink](../../native/mgu-uplink/README.md)),
which carry the secret the updater leaves in the app's data folder
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
  (or the running install; an app whose title another listed app has is
  named with its source, `DOOM (idrive7-apps)`), a grid of tiles: the package's picture when the
  updater names one (`components[].icon`, a PNG file), else a letter tile
  (round for a tool), its name, its source under it (the repo's name,
  `owner/repo` where two sources share a repo name, a catalog's host), its state (`Installed`, `Update 1.0.1`, `Downloading
  42 %`, `Waiting`, `Not for this head unit`, `Failed`, `Restart pending`, `Not working`,
  version and size) and a badge or progress ring. While a listed app or tool waits
  for a restart, **Restart now** sits left of the filters: Settings' confirm
  step, whose Restart is off while an install runs or waits. A component for another
  head unit only (the updater's `compat: "no"`) is listed only while
  installed, so it can be removed (on the widget screens too). A version
  not for this head unit is not counted as an update.
- **A component's page**: picture, name, author and source, Version, Commit, size, `Id
  <id>` (an app installed under another id than its source's), App
  or Tool, its head units and capability, the description; Installed and
  Available; the running phase (Downloading, Verifying, Building,
  Installing, Removing) with its progress; `Not installable` and why (a package of an id another source's app
  holds; installed, it shows as installed, with Remove and no update), `Not for this head unit` / `For
  iDrive 8` (that version is not offered), the failure in full (above the description), what is wrong with an installed component (the updater's `problem`: `In-page drawing unavailable: <reason>` from the renderer, `Not working: <reason>` for one that does not work until it is set up again after a firmware update), `Restart pending`; and what can be done:
  Install, Update to, Try again, Restart head unit, Undo update (where the updater offers the version before; a confirm step), Remove (a confirm step). A second renderer
  installs beside the first. On iDrive 8 an app install or removal is
  queued for the next start: its row shows `Restart pending`, as a tool
  pending a restart does.
- **Installed**: apps and head-unit tools, each with its version and
  source, its update (a press on Update installs it) or state, Update all,
  and Restart now beside it (as on Store). The ones with something running or
  waiting (an install, update or removal, a queued one, an update, a failure,
  a restart pending) come first; while the focus is on a row, the rows and
  Restart now stay as they are.
- **USB**: the components of the sticks' sources.
- **Settings**: the sources (each opens its page: channel, account,
  components, error, Remove with a confirm step, and while a sign-in does
  not reach a private one the GitHub App's install page as a QR code and
  its address), Add source, Wi-Fi (below), Accounts (each one's Remove with a confirm
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

## Languages

The Store is in the head unit's display language, every one the iDrive 7
and iDrive 8 HMI offers: English (UK, US), German, Dutch (also Flemish),
Danish, Swedish, Norwegian, Finnish, Polish, Czech, Slovak, Slovenian,
Hungarian, Romanian, French (France, Canada), Italian, Turkish, Spanish
(Spain, Latin America), Portuguese (Portugal, Brazil), Greek, Russian,
Ukrainian, Indonesian, Vietnamese, Japanese, Korean, Simplified Chinese
(also Cantonese simplified; translated by [JackieZ123430](https://github.com/JackieZ123430)),
Traditional Chinese (also Cantonese traditional), Arabic, Hebrew and Thai.
The drawn screens cannot lay out Arabic, Hebrew (right to left, joined
letters) or Thai (stacked marks): in those three the tile and the widget
screens are translated and the drawn screens are English.

It reads `currentDisplayLanguage` of HMIContext (`HMI_CID`, iDrive 7) and
HMIContext2 (`1`, iDrive 8), the manifest's proxies, at start and follows
each change; a value it cannot read is English. Names, versions, sources,
accounts, SSIDs and the updater's errors are shown as they are. A
component's title and description are in the language when its catalog
entry has them (`texts`, `release/README.md`), else English.

A language is one file, `locales/<code>.json`: the HMI's languages it is
for (`CommonTypes.Language`), its RHMI text files (named as the oap-sdk
names those languages), the glyphs it is drawn with, and its words, each
keyed by the English (`{0}`, `{1}` stand for the values); `"drawn": false`
keeps the drawn screens English:

```json
{ "hmiLanguages": ["CHINESISCH_SIMPLE", "KANTONESISCH_SIMPLE"], "rhmiTexts": ["zh_CN", "zh_yue_Hans_CN"],
  "font": "chinese", "words": { "Update {0}": "更新 {0}" } }
```

`tools/build.js` writes them into the Store (`src/locales.js`, by
`tools/gen_locales.js`) and, by `tools/gen_rhmi.js`, the RHMI text files
(`rhmiData/variantGroups/Common/texts`): the widget screens' own words are
string ids, which the HMI shows in its language, the Store's tile name too.
`tools/test_i18n.js` checks that every word the Store translates has a
translation in every language, with the same `{n}`, that every HMI language
has its text file, and that each language's words and catalog texts can be
drawn; `tools/test_fit.js` that no translation is cut on a drawn screen
where the English fits.

Inter has ASCII and `·…→–—°×` (`tools/bake_fonts.py`). Every other
language has a font of its own, used for text Inter cannot draw and
loaded the first time it is:

| `font` | Glyphs | Baked by |
|---|---|---|
| `latin`, `greek`, `cyrillic`, `vietnamese` | Inter with those letters, regular and semibold | `tools/bake_inter.py` |
| `chinese`, `chinese-tc`, `japanese`, `korean` | Noto Sans SC, TC, JP, KR (SIL OFL, `src/LICENSE-NotoSans*.txt`): the Store's words at 40 px, and the language's common characters for names and descriptions at 18 or 20 px | `tools/bake_cjk.py` |

The renderer's glyph texture (two columns of 1024 x 4096) is shared by
every app and keeps every atlas until the renderer restarts. Inter's and
one language's atlases fit with room to spare. After display-language
changes the texture can fill up, and the new language's text then shows
after the head unit's next start.

## The widget screens

| Row (`LT_Button_1Row_2Col7030_2Text`) | Press |
|---|---|
| `DOOM` · `Update 1.0.1` | update to the catalog version |
| `Gauges` · `Update a1b2c3d` | update to a branch's new commit (same version, new revision) |
| `Display bridge demo` · `Install 1.0.0` | install |
| `Network driver` · `Install 0.2.0` | install (an optional component) |
| `Vehicle control` · `Installed 1.0.0` | nothing; *Remove?* when the updater marks it `uninstallable` (every app but the Store) |
| `DOOM` · `42%` / `Verifying` / `Building` / `Installing` / `Removing` | nothing (in progress) |
| `Extended dashboard` · `Waiting` | nothing (queued) |
| `Display bridge` · `Restart pending` | nothing (installed; active after the next reboot) |
| `Cluster render` · `Not working` | as an installed row: installed, but not working until it is set up again (the updater's `repair`), which the updater has its source do |
| `Car Data` · `Restart pending` | an iDrive 8 app install queued for the next start (the updater's `nextStart: "install"`): *Remove?* when `uninstallable`, which drops it; a queued removal (`nextStart: "remove"`) offers nothing |
| `Car Data` · `Not for this head unit` | nothing (installed; the updater marks the new version `compat: "no"`); *Remove?* when `uninstallable` |
| `DOOM` · `Failed, retry` | try again (the status line names the error); a removal the last start failed to apply is removed again (*Remove?*); an install it failed to apply is installed again, and its page also has *Remove* (when `uninstallable`), which clears it |
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
are hidden with an updater that reports no `sources` or `web`. The status
line, like a source's error on its page, wraps over up to four rows on
iDrive 7 (`LT_Label_4Row_1TextDyn`).

**Remove?** names the component (`DOOM 1.0.1`) and has **Cancel** and
**Remove**, which asks the updater to uninstall it.

**Restart head unit** opens a confirm step, *Restart head unit?*, with
**Cancel** (focused first) and **Restart**. Restart asks the updater to
restart the head unit through the Node State Manager (its `reboot`
request). The updater refuses a restart in the first 4 minutes after a
start, within 10 minutes of the last one and after 3 in an hour; the
status line, Settings and the app's page then say why and when a restart
is possible. The row is hidden
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
login that reads it), **Components** (how many it lists), its error in full and
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

**Add token** opens the speller (on iDrive 8's drawn screens the keyboard
page, below, showing only the token's last four characters), titled
*GitHub token*; the text confirmed with OK, trimmed, goes to the updater
as `token-add`. The updater asks
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
source*. On iDrive 8, while the renderer draws the Store, it opens the
keyboard page instead: the title, the text and App Manager 2's on-screen
keyboard (digits, letters with Shift, `. / - _ :`, `https://`,
`github.com/`, `.com`, Delete, OK), a page of the drawn screens typed by
touch; OK takes the text, BACK or a tab leaves it. The keyboard also has
word keys with a symbols page (`#+=` / `abc`, every printable ASCII
symbol) for text that needs them (`src/store.js` `_type`). The text
confirmed with OK, trimmed, is:

- `owner/repo`, or a repo's address on github.com (`github.com/owner/repo`,
  `https://github.com/owner/repo`, with or without `.git` or a trailing
  slash): a GitHub repo. `…/tree/<branch>` adds it at once with `source-add`
  `type: "github"`, `repo`, `channel: "branch:<branch>"`. Without a branch
  the status line says `Checking <repo>` while the updater is asked what the
  repo has (`source-probe`); then the repo's page (below) opens, or a repo
  with only one choice is added on it, one with none without a channel, or
  the status line says why not (`Add source failed: Offline`, `GitHub limit
  reached. Try later or sign in.`, `… is already a source`, `the updater did not answer`
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
given the focus back from the speller or the keyboard page (or 2 s after
it closed), since the focus coming back below a page opened earlier
closes it. Leaving the keyboard of an Add token pressed there, with OK,
its back button or BACK, returns to the repo's page.

Leaving the speller or the keyboard page without OK, or OK with nothing
typed, sends nothing. A
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

## Wi-Fi

On the drawn screens, Settings has **Wi-Fi** while the uplink reports its
Wi-Fi (`state.uplink.wifi`: mgu-uplink 0.7.0 or newer on `uplink = auto`,
through an updater from 0.8.0; without them the row is not there), with
its state: `Online · <network>`, `Connected · <network>` (joined; the
uplink uses another device or waits for DHCP), `Connecting · <network>`,
`Not connected`, `Not used`, `Unavailable` (no radio, or the car uses it),
`Failed`, `Error`; the page shows the reason. Its page (from IterioDev App Manager 2.0.6's Wi-Fi page) lists,
while Wi-Fi is on, the network joined first, then the latest scan's,
strongest first, then saved ones out of range, each with `Online` /
`Connected` / `Connecting`, `Saved`, `Secured` or `Open` and its signal
(`Strong`, `Good`, `Weak`). A press on a saved or open network joins it
(`wifi-connect`); on a secured one not saved yet it opens the password:
on iDrive 8 the keyboard page with word keys and the symbols page, titled
with the network, whose **Connect** takes 8 to 63 characters; on iDrive 7
the HMI's speller. The password goes to the updater in that request and
is kept nowhere, logged nowhere. A saved network has **Forget** (a confirm
step, `wifi-forget`). The panel shows the state, address and signal, the
uplink's error (a join that failed) or the refusal of the last request,
and **Use Wi-Fi** / **Don't use Wi-Fi** (`wifi-enable`: whether the uplink uses Wi-Fi; Use Wi-Fi unblocks a soft-blocked radio and leaves it on), **Scan** (`wifi-scan`, also
asked when the page opens) and **Preferred: <kind>**, which opens the
preferred connection: Automatic, Wi-Fi, USB (adapters and LTE sticks),
Phone (Android and iPhone tethering): the uplink's `preferred` values
`wifi`, `usb`, `phone`; the one preferred marked, the one in use said so; a press makes it the one the uplink tries first
(`uplink-prefer`), the others staying fallbacks. The widget screens have
none of this.

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
locales/<code>.json        a language's words (README "Languages")
src/i18n.js                the words in the display language
src/locales.js             the languages, written by tools/gen_locales.js
src/kit_*.js               the kit: record, canvas, vicons, png, themes (MIT, src/LICENSE-kit.txt);
                           kit_fonts.js maps its families onto Inter, and a language's font onto its own atlases
src/font_regular.js, src/font_semibold.js   Inter glyph atlases (tools/bake_fonts.py)
robertn_store@<version>/fonts/<font>.json   a language's glyph atlases (tools/bake_inter.py, tools/bake_cjk.py)
lib/mgu_render_client.js   mgu-render's client, copied by tools/build.js
tools/gen_locales.js       src/locales.js from locales/*.json
tools/gen_rhmi.js          application.xml + uiDescription.json for iDrive 7 and 8 from one table, and the RHMI texts
tools/build.js             languages, RHMI, lib/, the source package, and given a donor the OAP tgz
tools/bake_fonts.py        the Inter atlases (Pillow, Inter 4.1's TTFs)
tools/bake_inter.py        the Latin, Greek, Cyrillic and Vietnamese atlases (Pillow, Inter 4.1's TTFs)
tools/bake_cjk.py          the Noto Sans SC, TC, JP and KR atlases (Pillow, google/fonts' TTFs, SHA-256 checked)
tools/gen_screens.py       src/am_screens.js from App Manager 2's screens.json
tools/fixture.js           an updater state with one of everything, and the drawn screens over it
tools/test_view.js         the texts for every row, source, account, sign-in and phone state
tools/test_rhmi.js         both HMIs' RHMI files, host states and proxies, the names src/store.js binds
tools/test_qr.js           the QR pictures (decoded back with zbarimg when installed)
tools/test_speller.js      src/speller.js against a fake use case factory
tools/test_screens.js      every drawn screen in iDrive 7's and 8's boxes: in the box, values, presses, focus order, scrolling, touch
tools/test_store.js        src/store.js's flows against stand-in SDK, RHMI, updater, speller and renderer
tools/test_i18n.js         every language: its words, placeholders, RHMI text files, fonts, catalog texts
tools/test_fit.js          every language's words on every drawn screen: nothing cut where the English fits
tools/shots.js             screenshots of the drawn screens through mgu-render --replay (STORE_LANGUAGE: in that language)
tools/test_drag.js         a drag frame against the frame built whole, through mgu-render --replay
tools/make_icon.py         the 140x140 tile icon
robertn_store@0.9.19/       staged package tree (no javascript/: the build writes it)
```

## Build

```sh
cd apps/robertn_store
node tools/build.js                                # robertn_store@0.9.19.src.tgz
node tools/build.js --sdk <donor .tgz|.js>         # and robertn_store@0.9.19.tgz (MGU_SDK_DONOR)
node tools/test_view.js && node tools/test_rhmi.js && node tools/test_qr.js && node tools/test_speller.js &&
    node tools/test_screens.js && node tools/test_store.js && STORE_HMI=ID8 node tools/test_store.js &&
    node tools/test_i18n.js
(cd ../../native/mgu-render && make test) && node tools/test_drag.js && node tools/shots.js <out dir>     # screenshots
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
The Store requires mgu-render and mgu-uplink (`release.json`), so an
install puts them on. The uplink is the Store's requirement, not the
updater's: mgu-uplink requires the updater, and the updater's planner
refuses two components that require each other.

## Needs the head unit

- iDrive 7: whether the HMI routes focus and presses to the page
  template's buttons, else FrontCCU's dial and push there; touch inside the
  page template; the compact layout's text and buttons for reading and
  pressing in the car.
- iDrive 8: the widget layout (`LT_State_Wide_List`, `LT_Button_MediaEntry_1Row`
  cells, the QR picture label), the layer host states' proxies and focus
  events, `mapEntryState` switching, the manifest's proxies under MainApp-21,
  the entry point's insertion there, typing on the keyboard page in the car,
  the Wi-Fi pages against the car's radio.
