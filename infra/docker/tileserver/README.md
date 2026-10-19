# Tileserver helper for local development

## Quick start

Download tile data and start the server:

```bash
# Install pmtiles CLI (one-time)
brew install pmtiles

# Download North America tiles (~2-3 GB, zoom 0-14)
./scripts/dev/download-tiles.sh

# Or download just the US (~1 GB)
./scripts/dev/download-tiles.sh --region us

# Start the tileserver
cd infra/docker && docker compose up -d tileserver
```

Open the tileserver UI at <http://localhost:8081/>

## Tile data location

Place a `.pmtiles` file at `infra/docker/tileserver/data/openmaptiles.pmtiles`.
TileServer GL reads PMTiles natively so no conversion is needed.

## Alternative download methods

```bash
# Direct URL (e.g. a hosted .pmtiles file)
./scripts/dev/download-tiles.sh --url https://example.com/tiles.pmtiles

# Copy from a GCS bucket
./scripts/dev/download-tiles.sh --gcs gs://hf-dev-tiles/openmaptiles.pmtiles
```

## Endpoints

- Tile UI: <http://localhost:8081/>
- Vector tiles: `http://localhost:8081/data/openmaptiles/{z}/{x}/{y}.pbf`
- Static images: `http://localhost:8081/styles/streets/static/{lng},{lat},{zoom}/{w}x{h}.png`

Static images (and raster `{z}/{x}/{y}.png` tiles) render through MapLibre's
native GL renderer, which needs a headless X display. `cors-proxy.mjs` starts
Xvfb for that; without it tileserver-gl aborts on the first raster request and
takes the container — vector tiles included — with it.

Rendering is also the memory floor for this container: it climbs ~60MiB per
image for the first several renders, then plateaus near 950MiB. Give it at least
2Gi. 512Mi was measured to OOM-kill it on the third static render.

## Production (GCS + Cloud Run)

Upload tiles to GCS for the Cloud Run tileserver:

```bash
./scripts/dev/sync-tiles-gcs.sh hf-dev-tiles
```

Then set `tileserver_gcs_bucket = "hf-dev-tiles"` in your Terraform tfvars.

If you need different styles or tile sources, edit `config/config.json`.
