# Flux Office side panel fixture

This standalone fixture mounts the real `FluxPanel` with mocked project and source API responses. It needs no database.

Start it from the repository root:

```sh
npx vite --config scripts/fixtures/office-flux-panel-ui/vite.config.ts --host 127.0.0.1 --port 4190
```

In another terminal, run the interaction, width and theme checks:

```sh
node scripts/fixtures/office-flux-panel-ui/check.mjs
```

Set `FLUX_CHROME` to the Chromium executable when it is not `/usr/bin/chromium`. The check saves four screenshots under `/tmp` and verifies the 320 px and 460 px panel widths, both themes, switching to another project, and changing the export source.
