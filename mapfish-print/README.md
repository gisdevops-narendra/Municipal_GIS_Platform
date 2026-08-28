# MapFish Print — Municipal GIS Platform

Print templates for the GIS workspace **Print Layout** tool.

`print-apps/municipal-gis/` is mounted read-only into the
`mapfish-print` container (see `docker-compose.yml`) at
`/usr/local/tomcat/webapps/ROOT/print-apps/municipal-gis`.

## Layout

| file | purpose |
|---|---|
| `config.yaml` | the print app: 4 layouts (`A4 portrait`, `A4 landscape`, `A3 portrait`, `A3 landscape`), attributes, processors |
| `A4-portrait.jrxml` … `A3-landscape.jrxml` | one JasperReports 6.20 page template per size + orientation |
| `legend.jrxml` | the per-row legend sub-template (`!prepareLegend`) |
| `north-arrow.svg` | the north-arrow graphic (`!northArrow`) |

Each page template renders, in one `title` band: the map (`$P{mapSubReport}`),
scale bar / north arrow / legend sub-reports (each gated by a `show*`
boolean), and text for title, metadata, date and attribution.

## Who builds the request

The browser never calls MapFish. `backend/src/gis/print.service.ts`:

* resolves the requested layer ids against the caller's tenant-scoped,
  permission-filtered layer list;
* sets every WMS `baseURL` to `MAPFISH_GEOSERVER_URL`
  (`http://geoserver:8080/geoserver` on the compose network);
* resolves `basemapId` against a fixed server-side allowlist (never a
  client URL);
* POSTs to `…/print/municipal-gis/buildreport.<pdf|png>` and streams the
  result back.

## Editing templates

Templates are validated by `!reportBuilder` on **every** print request, so
a syntax error in any `.jrxml` breaks all four layouts. After editing:

```bash
docker compose restart mapfish-print
# then, from inside any compose service that can reach it:
docker exec municipal-gis-backend \
  curl -s http://mapfish-print:8080/print/municipal-gis/capabilities.json | head -c 200
```

To render a test report directly, POST a spec to
`http://mapfish-print:8080/print/municipal-gis/buildreport.pdf`
(temporarily publish port `8080` in `docker-compose.yml` to reach it from
the host).

JasperReports 6.20 is strict: every element must fit **entirely inside**
its band (`y + height <= band height`), and columns + margins must not
exceed the page width.
