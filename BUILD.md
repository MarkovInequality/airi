# Building a Windows executable

If anything under `packages/` has changed since your last build, first run this from the
repository root:

```
pnpm build:packages
```

Some packages are consumed as built output rather than source, and the app build does not
build them. Skipping this silently bundles the stale copy — the executable builds and runs,
it just keeps the old behavior.

Then navigate to `apps/stage-tamagotchi` and run:

```
pnpm run build && pnpm exec electron-builder --win --dir
```

The output folder `dist/win-unpacked` should contain the executable.
