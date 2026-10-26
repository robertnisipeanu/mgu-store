# Updater changelog

## 0.3.0

- Tokens are the updater's own, not a source's: `credentials/tokens.json` and `credentials/token-<id>`. A GitHub source is read with the token that read it last, else each stored token until one reaches the repo (a repo known to be public without one first), so one token serves every repo it can read and a source added later needs none. `auth-needed` only when no stored token reaches the repo.
- `token-add` (checked with `api.github.com/user`: account and a classic token's scopes; one GitHub rejects is refused) and `token-remove` replace `token-set` and `token-clear`; `login-start` takes no source and its sign-in adds a token. The state has `tokens` (id, label, account, the sources each reads; never the text) and each source's `auth` names its token.
- Token files the deploy tool writes are picked up within `usb_poll_s`, without a restart.
- The per-source token files of 0.2.x become tokens at start, one per distinct text, and are removed once this version is committed.
- An https source is read without a token.
- The phone page has a Tokens section (paste, Sign in with GitHub, Remove); adding a source asks for no token.

## 0.2.1

- Without `sources.json` the updater reads the built-in source alone and writes nothing, so the installers' `updater-sources` seeds the file whichever starts first. The first-start conversion of an earlier updater's `updater.local.conf` `catalog` and `github-token` into sources is removed: units carry `sources.json` from the installers or from updater 0.2.0.
