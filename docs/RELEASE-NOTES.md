# Optional catalog release notes

A catalog component may include `releaseNotes`, a newest-first array:

```json
[
  { "version": "1.2.0", "changes": ["Fix an empty page after opening several apps."] },
  { "version": "1.1.0", "changes": ["Add a compact layout."] }
]
```

Each entry has one to three plain-text bullets, up to 120 characters each.
The updater accepts at most 16 entries, ignores malformed, duplicate and
future entries, and sorts accepted versions newest first. Missing notes do
not affect installation. Notes use the source's language; translated
per-language histories are outside this initial schema.

The Store offers “What's new” in app details and lets the owner browse
earlier versions. Reading notes never starts an update. The phone page
shows the same history as text, without interpreting HTML.

Maintainers can supply `release/notes.json`, mapping component IDs to
these histories. The first entry of a changed component uses
`"version": "next"`; release stamping records its resolved version.
Components without this optional file or an entry keep the existing
release behavior. Keep bullets specific and concise.
