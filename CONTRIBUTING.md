# Contributing

## Versions

Two kinds of components, with different rules:

- **Release-time versions:** `app-privacy`, `mgu-python`, `mgu-render` and
  `mgu-uplink`. Leave their version numbers alone. The release gives each
  one it publishes its next version and writes it into the tree. CI fails a
  pull request that changes their `"version"` in `component.json`.
- **Hand-versioned:** the Store (`robertn_store`), `mgu-updater` and
  `mgu-deploy`. A pull request that changes one of these raises its version
  itself (`node release/release.js bump <id> <x.y.z>`) and adds the
  CHANGELOG entry under that version.

For release-time components:

- **Patch** is the default.
- **Minor or major:** say so in the pull request; the maintainer adds the
  label `release:minor` or `release:major`. The label covers every component
  the pull request changes.

## CHANGELOG

A release-time component with a CHANGELOG (`native/<id>/CHANGELOG.md`)
lists what your pull request changes under `## Unreleased` at the top:

```md
# app-privacy changelog

## Unreleased

- What changes, in a sentence or two for the people who use it.

## 1.7.1
...
```

The release moves those lines under the new version's heading and leaves an
empty `## Unreleased` for the next pull requests. CI fails a pull request
that changes such a component without an Unreleased entry.

When another pull request added its lines first, GitHub reports a conflict
in the CHANGELOG. Merge `main` into your branch locally
(`git merge origin/main`): the repository's `.gitattributes` keeps both
sets of lines, so there is nothing to resolve by hand.

## Requiring another component's next release

When your change needs a change to another component of this repository in
the same or an earlier pull request, require that component's next release
with `"next"` in `"requires"` (a tool's `component.json`, the Store's
`release.json`):

```json
"requires": { "mgu-python": "next" }
```

The release writes the real version in and publishes both. This works
between any two components: the Store or the updater can require a
release-time tool's next release, and a release-time tool can require the
version a hand-versioned component's pull request set. Keep a component
that is already released at its number (`"mgu-deploy": "0.8.4"`).

## Updates in any order

Cars update each component on its own, in any order. A component that
needs a newer partner says so in `requires`; otherwise it keeps working
with the partners' published versions (AGENTS.md, "Updates must work in
any order").
