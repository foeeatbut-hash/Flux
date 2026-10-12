# Flux Office add-on fixture

This browser fixture mounts the real Flux Office add-on panel beside a stand-in GenOffice canvas. Its project-data API routes return the same catalog, query, file-state, preview, confirm, and template shapes used by the server. The editor callbacks record the native bridge requests, so the browser checks field binding, schema editing, preview/confirm, and apply flow without replacing or mocking the add-on UI.

Run the self-starting browser test from the repository root:

```sh
npx tsx scripts/test-office-addon-ui.ts
```

The runner chooses an available port, waits for Vite, runs the browser check, and closes the fixture. For manual inspection, start Vite and run the check separately:

```sh
npx vite --config scripts/fixtures/office-flux-panel-ui/vite.config.ts --host 127.0.0.1 --port 4190
node scripts/fixtures/office-flux-panel-ui/check.mjs
```

Set `FLUX_CHROME` if Chromium is installed outside `/usr/bin/chromium`. The check writes light/dark screenshots for 390, 760, and 1280 px viewports, plus loaded selection, field schema, and fill plan views. `OFFICE_ADDON_UI_DIR` selects the screenshot directory. It verifies query/template contracts, schema operations, editor callbacks, and the optimistic preview/confirm request.
