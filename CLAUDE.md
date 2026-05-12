# Eye in the Sky: Claude Code Instructions

## What this is

A Chrome (Manifest V3) extension that reads marketplace pages the user
already has open (MorphMarket primarily, plus FaunaClassifieds /
ReptileForumsUK / Preloved / Kijiji via `content_crossplatform.js`)
and POSTs the data to `https://geck-data.vercel.app/api/ingest`. The
extension makes no extra network requests of its own; it intercepts
the requests the host page already makes (`interceptor.js`,
`content_morphmarket.js`).

Without this extension running in the user's browser, the geck-data
project has no inbound marketplace data and Geck Inspect's market
analytics + morph reference photos go stale.

## Auto-merge policy

When the user asks for a change in this repo, the default flow is:

1. Open the PR (draft is fine if there are checks).
2. Wait for any required checks. This repo has no CI workflows
   configured today, so a `pending` Vercel-style status is not a
   blocker.
3. Once nothing is failing, **mark ready for review and merge into
   `main` without waiting for an explicit "go ahead"**. Use
   `mcp__github__merge_pull_request` with `merge_method: 'squash'`
   unless the user specified otherwise.
4. If a check fails, investigate and fix in the same PR.

The user's standing instruction is: never make them be the one to
merge. Don't ask "do you want me to merge?"; just merge.

Exception: destructive or irreversible changes (rewriting history,
forcing a release tag, mass-clearing user-local state via a new
manifest version) get a confirmation first.

## Config

`config.js` is gitignored. `config.example.js` is the template. Both
files define `CONFIG.API_KEY` and `CONFIG.INGEST_URL`. The API key
must match `INGEST_API_KEY` in the geck-data Vercel project, or every
POST 401s silently from the user's perspective (the popup's "Sync"
indicator surfaces it).

## Companion repos

- `tennysonmilesperhour/geck-data`: the ingest target. Schema lives in
  its `supabase/migrations/`.
- `tennysonmilesperhour/geck-inspect`: the web app that reads the
  ingested data and surfaces it.

## After a substantive change

The user has to manually reload the extension at
`chrome://extensions` for the new code to take effect. Mention this
in the merge summary so they don't forget.
