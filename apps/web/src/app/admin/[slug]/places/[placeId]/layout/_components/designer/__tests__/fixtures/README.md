# Detection Test Fixtures

Place reference images in this directory for layout auto-detection tests.

## Naming convention

- `<venue-name>-<source>.{png,jpg}` — e.g. `vaught-hemingway-seatgeek.png`
- Keep originals at whatever resolution they come in; the detection pipeline
  handles scaling internally.

## Notes

- These files are tracked by **Git LFS** (see `/.gitattributes`).
  Run `git lfs install` once after cloning if you haven't already.
- Do **not** commit copyrighted images from third-party sites without
  verifying the licence allows redistribution. Prefer screenshots of our own
  test venues, Creative Commons sources, or procedurally generated test grids.
- Large images (> 2000px on the longest side) are fine — the server-side
  detection pipeline downscales before processing.
