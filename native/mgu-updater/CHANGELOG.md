# Updater changelog

## 0.4.0

- The state names the head unit the deploy tool reports, `unit` (`hmi` `ID7`/`ID8`, `firmware`). Components carry `mguHmi` (catalog schema 2, `mgu-repo.json`, a component's manifest; an app package without it, from a stick or an index: the HMIs its rhmiData has a UI for) and `compat` (`yes`, `no`, `unknown`); installing one that is not for this unit, or needs one, is refused with the reason.
- A stick's `oap/` lists IterioDev's root-service packages (`mguService` `renderer`, `tether`) as tools, which the deploy tool installs as such (they need `mgu-deploy` 0.3.0 or newer); another `mguService` is left out.
- An https source answering an App Manager index (`{"packages": [{url, sha256}]}`) is read in index mode: each package downloaded once, checked against its sha256, kept by it while listed, and read for what it is.
- Capabilities: a tool's `mguProvides` (a service package: its kind). The state's `providers` names the installed provider of each, and a component providing the same one names it in `replaces`. Its install is refused unless the privileged `{"op":"install","id","replace":true}` asks for it, which installs it with the deploy tool's `--replace`. The phone page shows a component's capability and that it is not for this unit, and offers Replace.

## 0.3.0

- Tokens are the updater's own, not a source's: `credentials/tokens.json` and `credentials/token-<id>`. A GitHub source is read with the token that read it last, else each stored token until one reaches the repo (a repo known to be public without one first), so one token serves every repo it can read and a source added later needs none. `auth-needed` only when no stored token reaches the repo.
- `token-add` (checked with `api.github.com/user`: account and a classic token's scopes; one GitHub rejects is refused) and `token-remove` replace `token-set` and `token-clear`; `login-start` takes no source and its sign-in adds a token. The state has `tokens` (id, label, account, the sources each reads; never the text) and each source's `auth` names its token.
- Token files the deploy tool writes are picked up within `usb_poll_s`, without a restart.
- The per-source token files of 0.2.x become tokens at start, one per distinct text, and are removed once this version is committed.
- An https source is read without a token.
- The phone page has a Tokens section (paste, Sign in with GitHub, Remove); adding a source asks for no token.

## 0.2.2

- An installed component shows an update when any source, a USB stick included, lists a higher version. Among equal versions the source that installed it is preferred, then a stick, then `sources.json` order; the installing source becomes its origin.
- An updater or uplink installed from a stick while the unit is offline is kept: its check passes when the deploy tool answers, without the catalog.

## 0.2.1

- Without `sources.json` the updater reads the built-in source alone and writes nothing, so the installers' `updater-sources` seeds the file whichever starts first. The first-start conversion of an earlier updater's `updater.local.conf` `catalog` and `github-token` into sources is removed: units carry `sources.json` from the installers or from updater 0.2.0.
