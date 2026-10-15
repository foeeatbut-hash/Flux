# Equipment panel preview

This fixture mounts the production `src/screens/Equipment.tsx` screen in a minimal Flux shell. It adapts the extracted concept `UNIT.json` to the project systems API shape by serializing each `specs` object and supplies only fixture API responses through Playwright routing.

Run `node scripts/fixtures/equipment-panel/check.mjs` to start Vite on port 4198, launch Chromium, verify the unit/block/valve views at 1440 and 1100 px in light and dark themes, check horizontal overflow and write screenshots under `/tmp/equipment-panel-*.png`. The block fixture also demonstrates source origins using the extracted UNIT values: a catalog-origin characteristic is read-only (sky), while a fixture manual override remains amber. Two additional 1440 px screenshots show the catalog details expanded in both themes; the standard 12 panel screenshots keep the details collapsed.
