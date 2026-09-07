# Comment salvage

Facts removed from code comments because the no-comments rule allows only
one-line citations. Each entry names the file and symbol it came from. Prune
this file by verifying each fact and either citing a source or deleting it.

## src/lib/editor.ts / resolveEditor

- clack's select returns string | symbol, but isCancel narrows the symbol
  case above.

## src/lib/git.ts / selectWorktree

- p.select returns string | symbol, but isCancel above exits on symbol, and
  library types do not narrow.

## src/lib/auto-update.ts / scheduleBackgroundUpdateCheck

- POSIX setsid(): survives terminal close so a slow download isn't SIGHUPed.
- Close parent's fd copy even if Bun.spawn throws synchronously (else fd
  leak per launch).

## src/lib/auto-update.ts / probeBinaryRuns

- Bun.spawnSync returns null exitCode on timeout kill.

## src/lib/auto-update.ts / decodeProbeStream

- Emit a debuggable marker (not "") so a Bun API shape change is visible in
  last-error.

## src/lib/config.ts / readConfigFile

- file.exists() can throw on stat errors.

## src/lib/config.ts / shouldAutoUpdate

- file.exists() can throw EACCES.

## src/lib/fs-utils.ts / classifyWriteError

- Walks cause chain for errno; EBUSY/ETXTBSY treated as permanent (file
  locked/busy).

## src/lib/release.ts / withTimeout

- Drain the redirect body so keep-alive sockets don't pin across hops.
