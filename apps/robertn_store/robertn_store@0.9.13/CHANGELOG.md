# Changelog

## 0.9.13

A private source no signed-in account reaches shows the GitHub App's
install page titled *Install on GitHub* when the repo belongs to a
signed-in account, else *Ask the owner to install*: only a repo's owner
can install the App on it.

## 0.9.12

Installed lists the apps and the tools that something runs or waits on
first: an install, update or removal running or queued, an update, a
failure, a restart pending. The rest follow, each part in the catalog's
order, and a row moves as its state changes, except while the focus is on
one of the lists' rows, which then stay where they are.

## 0.9.11

Dragging a list or grid moves its rows without building the page again:
the page without them and the rows around the ones shown are drawn once
and kept by the renderer, and each drag frame places the rows, which takes
a fraction of a millisecond in place of a whole page build. They are drawn
ahead once a page with a scrolling list has stayed for 0.3 s, kept from one
swipe to the next while the page shows the same, and dropped while the
Store is hidden. Another page ends a drag, and its first frame waits up to
0.1 s for its pictures, so a page is shown whole. The rows stop on
whole pixels, where a press then finds them. A new state from the updater
or a picture decoded during a drag waits for its release (pictures redraw
the cached rows); a state the page shows already builds nothing. The Store
asks the renderer for up to 60 frames a second (mgu-render 0.6.2's
`fps.robertn_store` setting gives it another). While mgu-render's
stats-log is on, the Store's line also splits its builds into model and
layout and counts the drag frames, and each step of its frames and touches
goes to `/dev/shm/robertn_store-trace.log` beside mgu-render's trace.

## 0.9.10

While mgu-render's stats-log (`/run/mgu-render/stats-log`) exists, the
Store logs once a second the frames it built and sent, their times, the
touch events and its CPU.

## 0.9.9

Dragging a list builds the drawn frame only when the renderer asks for the
next one (its TICK), not on every finger move while the renderer still has
the frame before.

## 0.9.8

An app install queued for the next start (iDrive 8: MainApp takes the
app only then) shows `Restart pending` instead of Install or Update
again, on its tile, its row and the Installed tab, and is not counted
as an update; its page offers Restart head unit. Before, a first
install showed Install once it finished (with mgu-updater 0.8.2 the
updater reports it pending), and a press installed it a second time. An
app whose removal is queued shows `Restart pending` too.

With mgu-updater 0.8.2: a queued first install can be removed, which
drops it from the queue; an app whose removal is queued for the next
start offers no Remove again. A change the last start failed to apply
shows as Failed with the reason (the updater's error): Try again repeats
what failed, the removal or the install, and an install that failed can
also be cleared with Remove.

## 0.9.7

An installed tool's page shows what the tool says is wrong (the updater's
`problem`, mgu-updater 0.8.1): the Renderer's `In-page drawing unavailable:
<reason>` when it could not make its HMI page template (mgu-render 0.4.1).

## 0.9.6

Wi-Fi and the preferred connection, on the drawn screens (from IterioDev
App Manager 2.0.6 Wi-Fi pages): Settings has Wi-Fi with its state while
the uplink reports its Wi-Fi (mgu-uplink 0.7.0, through mgu-updater
0.8.0; without them the Store is as before). Its page lists the networks (the
one joined, the latest scan's, saved ones out of range) with their
state and signal; a press joins a saved or open network, or asks a
secured one's password: on iDrive 8 the keyboard page with word keys
and symbols, Connect from 8 to 63 characters; on iDrive 7 the HMI's
speller. Forget (with a confirm step), Use Wi-Fi / Don't use Wi-Fi, Scan (also when the
page opens), and the preferred connection: Automatic, Wi-Fi, USB or
Phone, tried first with the others as fallbacks. Wi-Fi the car itself
uses shows as Unavailable, with the reason. A password goes to the updater
only and is not logged. The keyboard page's text box can have a caption,
and its Enter key a minimum length.

## 0.9.5

Typing works on iDrive 8: while the renderer draws the Store, Add source
and Add token open a page with the text and an on-screen keyboard (from
IterioDev App Manager 2.0.6 keyboard): digits, letters with Shift,
`. / - _ :`, `https://`, `github.com/` and `.com`, Delete and OK, typed
by touch, one character per tap. A token shows only its last four
characters. OK takes the text as the speller's OK does; BACK or a tab
leaves the page and sends nothing. The keyboard also has word keys with
a symbols page (`#+=` / `abc`) holding every printable ASCII symbol, for
text that needs them. iDrive 7 and the widget screens keep the HMI's
speller.

## 0.9.4

Touch scrolling of the Store's grids and lists follows the finger and
stops wherever it is let go, a row part way out of view included; a
part-shown tile or row takes a tap on its shown part. The controller
scrolls the focused item fully into view.

## 0.9.3

Each Store and USB tile names its source under the title: the repo's
name, owner/repo where two sources share a repo name, a catalog's host.
Installed rows name it after the version. The tile icons are a little
smaller to make room for the line. The app page's title is the app's
name alone; its `from …` line names the source. The status line and
*Remove?* name the source of an app another source lists under the
same title, as in `Downloading 42 % · DOOM (idrive7-apps)`.

## 0.9.2

The Store lists only what is for this head unit: an app or tool for the
other iDrive only no longer shows on the Store, Apps, Tools and USB lists,
unless it is installed, so it can still be removed.

## 0.9.1

On iDrive 8 the Store has its tile and opens, drawn by the renderer; touch,
the controller and BACK work, going back one page at a time. Needs
mgu-deploy 0.5.1, which gives it its tile, and mgu-render 0.3.1.

## 0.9.0

Add source offers what a GitHub repository has. After `owner/repo` (or a
repo's github.com address) is typed, the updater is asked what the repo
has (`source-probe`), and a page lists only that: Releases if it has a
release, Tags if it has an x.y.z tag, and its branches, main and master
first, then the default branch, then the rest. A press adds the repo on
it, under the name as GitHub spells it. A repo with only one of these is added on it with no page, and
one with none (no release, tag or branch a channel takes) without a channel, as typed; a
`/tree/<branch>` address adds that branch at once. A repo no account
reaches gets Sign in with GitHub and Add token on its page, and is asked
about again once an account is added. Offline, a spent GitHub rate limit or
another failure, or no answer from the updater within 30 s or its going
away, shows on the Sources status line, or on the page with Try again.
Add token's status shows on the page only for an Add token pressed there. The page opens only once the HMI has given the focus back from the
speller. Requires mgu-updater 0.7.0; with an older updater the repo is
added as typed.

Each source's component of an id is its own tile and row (mgu-updater
0.7.0): two repositories' Doom are two, each named with its source. A
component's page follows its row when an install gives the row another id,
and shows `Id <id>` when it installs under another id than its source's. An
installed component without an origin shows no source.

## 0.8.2

Add source adds what is typed at once: `owner/repo`, or a repo's address
on github.com (`https://` or not, `.git`, a trailing slash; `/tree/<branch>`
reads that branch), is a GitHub source the updater reads on its releases,
or its default branch when it has none; any other https address is a
catalog. The updater's refusal shows on the Sources status line. Accounts
has Add token: a GitHub token typed in the speller, with `Checking token`,
the account it added, or the refusal on the page's status line.

## 0.8.1

On iDrive 7 the drawn screens are laid out for the renderer's box itself
(1796 x 632 in the page, 1790 x 638 as a layer) at full size: a one-row
header (title, status, filters, online state), small margins, three rows
of tiles, larger text, list rows and buttons, and nothing at the box's
edges. Settings' versions line wraps onto a second line, so every installed
renderer shows. iDrive 8 is unchanged.

## 0.8.0

A component providing what another installed tool provides installs
beside it, as any other: no Replace step (renderers run side by side,
mgu-render 0.2.0). Settings names every installed renderer. The drawn
screens connect to mgu-render's own socket, and to the community one when
nothing listens there. Needs mgu-updater 0.6.0.

## 0.7.1

An app another source's app holds the id of shows `Id <id>` on its page:
the id it installs under (mgu-updater 0.5.3). A package that cannot
install beside it says `Not installable` and why, with nothing to press.

## 0.7.0

The Store's screens are drawn by mgu-render: IterioDev's App Manager 2
(side menu Store, Installed, USB, Settings; a grid of tiles with package
pictures or letter tiles, states and badges; a component's page with
Installed and Available; confirm sheets), on iDrive 7 and iDrive 8, with
the controller (a ring on the drawn page: the HMI's focus over hidden
buttons, or FrontCCU's dial and push inside the page template) and touch. The widget screens show whenever the renderer is not
there, and the Store moves between the two as it comes and goes. A
component providing what another installed tool provides asks Replace?
and installs with replace. Package pictures and authors show where the
updater gives them. Sign in with GitHub shows while the updater
offers it, and a private source a sign-in does not reach shows the GitHub
App's install page as a QR code. The sign-in page has Cancel first, so the
QR code stays in view; a removed source's page closes once the confirm
step has given it back the focus. An iDrive 8 widget layout. Needs
mgu-updater 0.4.0, mgu-deploy 0.3.0 and mgu-render 0.1.1.

## 0.6.0

The package ships no entry point of its own: the build supplies
`javascript/runner.js` from the SDK donor's package, so the Store needs
mgu-deploy 0.2.4 or later to build on the head unit.

A version the updater marks as not for this head unit shows `Not for this
head unit`, is not counted as an update, and a press does not install it.

## 0.5.0

Accounts are the updater's tokens, not a source's: Sources has an
**Accounts** row, whose page lists each account with the sources it reads
(`2 sources`, `Unused`, `Rejected`); pressing one opens *Remove account?*
with its name and sources, and **Sign in with GitHub** adds one. The updater
reads each source with whichever account reaches it: a source's row shows
that account (or `Sign in` when none does), and a source's page has no
sign-in of its own. Needs mgu-updater 0.3.0.

## 0.4.1

With no updater to reach and none run since the Store was installed (no
secret in its data folder: the state the install kit leaves until the head
unit's next start), the status line reads `Restart the head unit to finish
setup`; `Updater not running` once the updater has run.

## 0.4.0

The Store lists the components of every source the updater reads. Sources
lists each source with its status; a source's page shows its channel,
account and component count, signs in with GitHub (a QR code of the
sign-in page with the code beside it) and removes the source after a
confirm step. Add source opens the HMI's speller for owner/repo or an https
address; a GitHub repo then gets its channel: Releases, Tags or Branch.
Phone access turns the updater's phone page on or off and shows its access
URL, which the updater leaves in the app's data folder, as a QR code. A
component the catalog marks `uninstallable` is removed from its row after a
confirm step. Privileged
requests carry the secret the updater leaves in the app's data folder. A
branch's new commit at the same version shows as `Update <revision>`, and a
build on the unit as `Building`.

## 0.3.2

Restart head unit on the start screen restarts the head unit through the
Node State Manager, by mgu-updater (0.1.4 or later), after a confirm step.
The status line no longer says apps restart while an app installs.

## 0.3.1

The Apps and Head-unit tools lists show every component of the catalog,
however many there are.

## 0.3.0

The start screen has the status line, Check for updates and the running
install's progress; Apps and Head-unit tools each open their own list.

## 0.2.0

The app's id is `robertn_store`: the car's own provisioning has a section
named `store` that does not allow it.

## 0.1.2

A row with an update or install available shows it even while a restart
is pending.

## 0.1.1

A row shows "Checking" while the updater checks a newly installed
head-unit tool.

## 0.1.0

The Store: one row per app and head-unit tool in the published catalog, with
its state (installed version, update available, not installed) and the
progress of the running install. Pressing a row installs or updates it
through mgu-updater (native/mgu-updater), which does the download and the
install; the app only shows its state and sends the request.
