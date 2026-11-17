"""Generates the Municipal GIS MapFish print templates (jrxml + config.yaml).

Usage:  python3 mapfish-print/gen_print.py mapfish-print/print-apps/municipal-gis

Map-area sizes here must match MAP_AREA_PT in
src/app/features/gis/components/print-layout/print-layout.component.ts
(the on-map print frame) — change both together.
"""
import sys, os
OUT = sys.argv[1]
ACCENT = "#0F766E"; INK = "#1C2430"; MUTED = "#5B6572"; LINE = "#C7CDD4"

def esc(s): return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")

def text(x, y, w, h, expr, size=8, bold=False, color=INK, align="Left", when=None, valign="Top", stretch=False):
    pw = f'\n          <printWhenExpression><![CDATA[{when}]]></printWhenExpression>' if when else ''
    st = ' isStretchWithOverflow="true"' if stretch else ''
    return f'''      <textField isBlankWhenNull="true"{st}>
        <reportElement x="{x}" y="{y}" width="{w}" height="{h}" forecolor="{color}">{pw}
        </reportElement>
        <textElement textAlignment="{align}" verticalAlignment="{valign}"><font size="{size}" isBold="{'true' if bold else 'false'}"/></textElement>
        <textFieldExpression><![CDATA[{expr}]]></textFieldExpression>
      </textField>
'''

def static(x, y, w, h, s, size=8, bold=True, color=INK, when=None):
    pw = f'\n          <printWhenExpression><![CDATA[{when}]]></printWhenExpression>' if when else ''
    return f'''      <staticText>
        <reportElement x="{x}" y="{y}" width="{w}" height="{h}" forecolor="{color}">{pw}
        </reportElement>
        <textElement><font size="{size}" isBold="{'true' if bold else 'false'}"/></textElement>
        <text><![CDATA[{s}]]></text>
      </staticText>
'''

def line(x, y, w, color=LINE, width=0.5):
    return f'''      <line>
        <reportElement x="{x}" y="{y}" width="{w}" height="1"/>
        <graphicElement><pen lineWidth="{width}" lineColor="{color}"/></graphicElement>
      </line>
'''

def rect(x, y, w, h, color=LINE, width=0.75, when=None, fill=None):
    pw = f'\n          <printWhenExpression><![CDATA[{when}]]></printWhenExpression>' if when else ''
    mode = f' mode="Opaque" backcolor="{fill}"' if fill else ' mode="Transparent"'
    return f'''      <rectangle>
        <reportElement x="{x}" y="{y}" width="{w}" height="{h}"{mode}>{pw}
        </reportElement>
        <graphicElement><pen lineWidth="{width}" lineColor="{color}"/></graphicElement>
      </rectangle>
'''

def sub(x, y, w, h, param, when=None, ds=None):
    pw = f'\n          <printWhenExpression><![CDATA[{when}]]></printWhenExpression>' if when else ''
    d = f'\n        <dataSourceExpression><![CDATA[{ds}]]></dataSourceExpression>' if ds else ''
    return f'''      <subreport>
        <reportElement x="{x}" y="{y}" width="{w}" height="{h}">{pw}
        </reportElement>{d}
        <subreportExpression><![CDATA[$P{{{param}}}]]></subreportExpression>
      </subreport>
'''

PARAMS = ["mapSubReport", "scalebarSubReport", "northArrowSubReport", "legendSubReport", "overviewMapSubReport",
          "title", "metadata", "printDate", "attribution", "organisation", "preparedBy", "notes", "scaleText", "crsText"]
BOOLS = ["showLegend", "showScalebar", "showNorthArrow", "showOverview"]
NONEMPTY = lambda p: f'$P{{{p}}} != null && $P{{{p}}}.trim().length() > 0'

def info_box(x, y, w):
    """Scale / CRS / prepared by / date rows; returns (xml, height)."""
    rows = [("Scale", "$P{scaleText}", None), ("Projection", "$P{crsText}", None),
            ("Prepared by", "$P{preparedBy}", NONEMPTY("preparedBy")), ("Date", "$P{printDate}", NONEMPTY("printDate"))]
    xml = static(x, y, w, 12, "MAP INFORMATION", 7.5, True, ACCENT)
    yy = y + 14
    lw = 60
    for label, expr, when in rows:
        xml += text(x, yy, lw, 11, f'"{label}"', 7, False, MUTED, when=when)
        xml += text(x + lw, yy, w - lw, 11, expr, 7, True, INK, when=when)
        yy += 12
    return xml, yy - y

def build(name, pw, ph, m, layout):
    W, H = pw - 2 * m, ph - 2 * m
    L = layout
    x = []
    # header
    x.append(rect(0, 0, 4, 34, ACCENT, 0, fill=ACCENT))
    x.append(text(12, 0, W - 260, 20, "$P{title}", L["title"], True, INK))
    x.append(text(12, 21, W - 260, 13, "$P{metadata}", 8.5, False, MUTED, when=NONEMPTY("metadata")))
    x.append(text(W - 240, 2, 240, 14, "$P{organisation}", 10, True, INK, "Right"))
    x.append(text(W - 240, 18, 240, 12, "$P{printDate}", 8, False, MUTED, "Right", when=NONEMPTY("printDate")))
    x.append(line(0, 40, W, ACCENT, 1.25))
    # map + frame
    mx, my, mw, mh = L["map"]
    x.append(sub(mx, my, mw, mh, "mapSubReport"))
    x.append(rect(mx, my, mw, mh, "#8A949E", 0.75))
    sbw, sbh = L["scalebar"]
    x.append(sub(mx + 8, my + mh - sbh - 6, sbw, sbh, "scalebarSubReport", "$P{showScalebar}"))
    na = L["north"]
    x.append(sub(mx + mw - na - 8, my + 8, na, na + 6, "northArrowSubReport", "$P{showNorthArrow}"))
    # legend
    lx, ly, lw, lh = L["legend"]
    x.append(static(lx, ly, lw, 12, "LEGEND", 7.5, True, ACCENT, when="$P{showLegend}"))
    x.append(line(lx, ly + 13, lw, LINE, 0.5))
    x.append(sub(lx, ly + 17, lw, lh - 17, "legendSubReport",
                 "Boolean.TRUE.equals($P{showLegend}) && $P{legendDataSource} != null", "$P{legendDataSource}"))
    # info box
    ix, iy, iw = L["info"]
    ib, ih = info_box(ix, iy, iw)
    x.append(ib)
    # overview
    ox, oy, ow, oh = L["overview"]
    x.append(static(ox, oy - 14, ow, 12, "LOCATION", 7.5, True, ACCENT, when="$P{showOverview}"))
    x.append(sub(ox, oy, ow, oh, "overviewMapSubReport", "$P{showOverview}"))
    x.append(rect(ox, oy, ow, oh, "#8A949E", 0.75, when="$P{showOverview}"))
    # footer
    fy = H - 30
    x.append(line(0, fy, W, LINE, 0.5))
    x.append(text(0, fy + 4, W - 330, 24, "$P{notes}", 6.5, False, MUTED, when=NONEMPTY("notes")))
    x.append(text(W - 320, fy + 4, 320, 10, "$P{attribution}", 6.5, False, MUTED, "Right"))
    x.append(text(W - 320, fy + 15, 320, 10, '"Generated with Municipal GIS Platform"', 6.5, False, "#8A949E", "Right"))
    params = "\n".join(f'  <parameter name="{p}" class="java.lang.String"/>' for p in PARAMS)
    params += '\n  <parameter name="legendDataSource" class="net.sf.jasperreports.engine.data.JRTableModelDataSource"/>\n'
    params += "\n".join(f'  <parameter name="{p}" class="java.lang.Boolean"/>' for p in BOOLS)
    body = "".join(x)
    return f'''<?xml version="1.0" encoding="UTF-8"?>
<!-- GENERATED by gen_print.py — page layout for the Municipal GIS print. -->
<jasperReport xmlns="http://jasperreports.sourceforge.net/jasperreports"
    xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
    xsi:schemaLocation="http://jasperreports.sourceforge.net/jasperreports http://jasperreports.sourceforge.net/xsd/jasperreport.xsd"
    name="{name}" pageWidth="{pw}" pageHeight="{ph}" columnWidth="{W}" columnCount="1"
    leftMargin="{m}" rightMargin="{m}" topMargin="{m}" bottomMargin="{m}"
    isTitleNewPage="false" isSummaryNewPage="false" whenNoDataType="AllSectionsNoDetail">
{params}
  <title>
    <band height="{H}" splitType="Prevent">
{body}    </band>
  </title>
</jasperReport>
''', L

LAYOUTS = {}
# A4 landscape: 842 x 595, margin 20 -> 802 x 555. Side panel 190 on the right.
LAYOUTS["A4-landscape"] = (842, 595, 20, dict(title=15, map=(0, 48, 600, 474), scalebar=(150, 32), north=34,
    legend=(612, 48, 190, 214), info=(612, 268, 190), overview=(612, 404, 190, 118), legendCols=1))
# A3 landscape: 1191 x 842, margin 24 -> 1143 x 794
LAYOUTS["A3-landscape"] = (1191, 842, 24, dict(title=18, map=(0, 48, 935, 712), scalebar=(170, 36), north=42,
    legend=(947, 48, 196, 380), info=(947, 436, 196), overview=(947, 566, 196, 194), legendCols=1))
# A4 portrait: 595 x 842, margin 20 -> 555 x 802. Bottom panel: legend | info | overview
LAYOUTS["A4-portrait"] = (595, 842, 20, dict(title=15, map=(0, 48, 555, 560), scalebar=(150, 32), north=34,
    legend=(0, 618, 196, 152), info=(206, 618, 160), overview=(376, 632, 179, 138), legendCols=1))
# A3 portrait: 842 x 1191, margin 24 -> 794 x 1143
LAYOUTS["A3-portrait"] = (842, 1191, 24, dict(title=18, map=(0, 48, 794, 860), scalebar=(170, 36), north=42,
    legend=(0, 918, 400, 191), info=(412, 918, 180), overview=(602, 932, 192, 177), legendCols=2))

def legend_jrxml(name, cols):
    cw = 190
    width = cols * cw + (cols - 1) * 10
    return f'''<?xml version="1.0" encoding="UTF-8"?>
<!-- GENERATED by gen_print.py. One row = one {cw}x18 pt PNG (symbol + label,
     drawn by the app); the name band serves GeoServer's legend fallback. -->
<jasperReport xmlns="http://jasperreports.sourceforge.net/jasperreports"
    xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
    xsi:schemaLocation="http://jasperreports.sourceforge.net/jasperreports http://jasperreports.sourceforge.net/xsd/jasperreport.xsd"
    name="{name}" columnCount="{cols}" pageWidth="{width}" pageHeight="1100" columnWidth="{cw}"
    columnSpacing="10" leftMargin="0" rightMargin="0" topMargin="0" bottomMargin="0">
  <field name="name" class="java.lang.String"/>
  <field name="icon" class="java.awt.Image"/>
  <field name="level" class="java.lang.Integer"/>
  <detail>
    <band height="14" splitType="Prevent">
      <printWhenExpression><![CDATA[$F{{name}} != null && !$F{{name}}.trim().equals("")]]></printWhenExpression>
      <textField isBlankWhenNull="true">
        <reportElement x="0" y="1" width="{cw}" height="12" forecolor="{INK}"/>
        <textElement verticalAlignment="Middle"><font size="8" isBold="true"/></textElement>
        <textFieldExpression><![CDATA[$F{{name}}]]></textFieldExpression>
      </textField>
    </band>
    <band height="18" splitType="Prevent">
      <printWhenExpression><![CDATA[$F{{icon}} != null]]></printWhenExpression>
      <image scaleImage="RetainShape" hAlign="Left" vAlign="Middle" isUsingCache="false">
        <reportElement x="0" y="0" width="{cw}" height="18"/>
        <imageExpression><![CDATA[$F{{icon}}]]></imageExpression>
      </image>
    </band>
  </detail>
</jasperReport>
'''

ATTRS = """      title: !string { default: '' }
      metadata: !string { default: '' }
      printDate: !string { default: '' }
      attribution: !string { default: '' }
      organisation: !string { default: '' }
      preparedBy: !string { default: '' }
      notes: !string { default: '' }
      scaleText: !string { default: '' }
      crsText: !string { default: '' }
      showLegend: !boolean { default: true }
      showScalebar: !boolean { default: true }
      showNorthArrow: !boolean { default: true }
      showOverview: !boolean { default: false }"""

def config(layouts):
    out = ["""# MapFish Print v3 configuration — Municipal GIS Platform.
# GENERATED by mapfish-print/gen_print.py together with the *.jrxml page
# layouts; edit the generator, not this file. The NestJS backend
# (backend/src/gis/print.service.ts) builds every request from the live
# map and the caller's permitted layers; URL safety is enforced there.

throwErrorOnExtraParameters: true

pdfConfig: !pdfConfig
  compressed: true
  author: 'Municipal GIS Platform'
  creator: 'Municipal GIS Platform — MapFish Print'

templates:"""]
    for key, (pw, ph, m, L) in layouts.items():
        size, orient = key.split("-")
        mx, my, mw, mh = L["map"]
        ox, oy, ow, oh = L["overview"]
        sbw, sbh = L["scalebar"]
        leg = "legend-2col.jrxml" if L["legendCols"] == 2 else "legend.jrxml"
        out.append(f"""  {size} {orient}: !template
    reportTemplate: {key}.jrxml
    attributes:
{ATTRS}
      map: !map
        maxDpi: 300
        dpiSuggestions: [96, 150, 300]
        width: {mw}
        height: {mh}
      overviewMap: !overviewMap
        width: {ow}
        height: {oh}
        maxDpi: 300
        zoomFactor: 6
      legend: !legend
        default: {{ name: '' }}
      scalebar: !scalebar
        width: {sbw}
        height: {sbh}
        default:
          type: bar
          unit: m
          geodetic: true
          renderAsSvg: true
          fontSize: 7
          barSize: 5
          intervals: 4
          backgroundColor: 'rgba(255, 255, 255, 0.85)'
      northArrow: !northArrow
        size: {L['north']}
        default:
          graphic: 'file://north-arrow.svg'
          backgroundColor: 'rgba(255, 255, 255, 0)'
    processors:
      - !reportBuilder {{ directory: '.' }}
      - !createMap {{}}
      - !createOverviewMap {{}}
      - !createScalebar {{}}
      - !createNorthArrow {{}}
      - !prepareLegend
        template: {leg}
""")
    return "\n".join(out)

for key, (pw, ph, m, L) in LAYOUTS.items():
    xml, _ = build(key, pw, ph, m, L)
    open(os.path.join(OUT, f"{key}.jrxml"), "w").write(xml)
open(os.path.join(OUT, "legend.jrxml"), "w").write(legend_jrxml("legend", 1))
open(os.path.join(OUT, "legend-2col.jrxml"), "w").write(legend_jrxml("legend-2col", 2))
open(os.path.join(OUT, "config.yaml"), "w").write(config(LAYOUTS))
print("ok")
