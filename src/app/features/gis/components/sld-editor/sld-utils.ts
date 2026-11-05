import type { StyleGeometry } from '../../../../core/models/layer-style.model';

export type SldTemplateKind = 'single' | 'rules' | 'labels';

/** First XML well-formedness problem (with its line when the browser
 *  reports one), or null when the text parses. */
export function xmlProblem(text: string): { message: string; line?: number } | null {
  if (!text.trim()) return { message: 'The SLD is empty.' };
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  const error = doc.getElementsByTagName('parsererror')[0];
  if (error) {
    const raw = (error.textContent ?? 'Invalid XML.').replace(/\s+/g, ' ').trim();
    const line = /line\s*(?:number\s*)?(\d+)/i.exec(raw);
    const detail = /:\s*(.+?)(?:Below is a rendering.*)?$/i.exec(raw)?.[1] ?? raw;
    return { message: `XML error: ${detail}`, line: line ? Number(line[1]) : undefined };
  }
  const root = doc.documentElement;
  if (root.localName !== 'StyledLayerDescriptor') {
    return { message: `The root element must be <StyledLayerDescriptor>, not <${root.nodeName}>.`, line: 1 };
  }
  return null;
}

/** Re-indents XML two spaces per level, keeping comments and CDATA.
 *  Returns null when the text is not well-formed. */
export function formatXml(text: string): string | null {
  if (xmlProblem(text)) return null;
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  const out: string[] = [];
  const decl = /^\s*(<\?xml[^?]*\?>)/.exec(text)?.[1] ?? '<?xml version="1.0" encoding="UTF-8"?>';
  out.push(decl);
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const attr = (s: string) => esc(s).replace(/"/g, '&quot;');
  const walk = (node: Node, depth: number) => {
    const pad = '  '.repeat(depth);
    if (node.nodeType === Node.COMMENT_NODE) {
      out.push(`${pad}<!--${node.nodeValue}-->`);
      return;
    }
    if (node.nodeType === Node.CDATA_SECTION_NODE) {
      out.push(`${pad}<![CDATA[${node.nodeValue}]]>`);
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const el = node as Element;
    const attrs = Array.from(el.attributes).map((a) => ` ${a.name}="${attr(a.value)}"`).join('');
    const children = Array.from(el.childNodes).filter(
      (c) => !(c.nodeType === Node.TEXT_NODE && !c.nodeValue?.trim()),
    );
    if (!children.length) {
      out.push(`${pad}<${el.tagName}${attrs}/>`);
    } else if (children.length === 1 && children[0].nodeType === Node.TEXT_NODE) {
      out.push(`${pad}<${el.tagName}${attrs}>${esc(children[0].nodeValue!.trim())}</${el.tagName}>`);
    } else {
      out.push(`${pad}<${el.tagName}${attrs}>`);
      for (const c of children) {
        if (c.nodeType === Node.TEXT_NODE) out.push(`${pad}  ${esc(c.nodeValue!.trim())}`);
        else walk(c, depth + 1);
      }
      out.push(`${pad}</${el.tagName}>`);
    }
  };
  walk(doc.documentElement, 0);
  return out.join('\n') + '\n';
}

function symbolizer(geometry: StyleGeometry, fill: string, stroke: string, indent: string): string {
  const i = indent;
  switch (geometry) {
    case 'point':
      return `${i}<PointSymbolizer>
${i}  <Graphic>
${i}    <Mark>
${i}      <WellKnownName>circle</WellKnownName>
${i}      <Fill><CssParameter name="fill">${fill}</CssParameter></Fill>
${i}      <Stroke><CssParameter name="stroke">${stroke}</CssParameter><CssParameter name="stroke-width">1</CssParameter></Stroke>
${i}    </Mark>
${i}    <Size>8</Size>
${i}  </Graphic>
${i}</PointSymbolizer>`;
    case 'line':
      return `${i}<LineSymbolizer>
${i}  <Stroke>
${i}    <CssParameter name="stroke">${stroke}</CssParameter>
${i}    <CssParameter name="stroke-width">1.5</CssParameter>
${i}  </Stroke>
${i}</LineSymbolizer>`;
    case 'raster':
      return `${i}<RasterSymbolizer>
${i}  <Opacity>1</Opacity>
${i}</RasterSymbolizer>`;
    default:
      return `${i}<PolygonSymbolizer>
${i}  <Fill>
${i}    <CssParameter name="fill">${fill}</CssParameter>
${i}    <CssParameter name="fill-opacity">0.6</CssParameter>
${i}  </Fill>
${i}  <Stroke>
${i}    <CssParameter name="stroke">${stroke}</CssParameter>
${i}    <CssParameter name="stroke-width">0.5</CssParameter>
${i}  </Stroke>
${i}</PolygonSymbolizer>`;
  }
}

/** Starter SLD 1.0 documents for the layer's geometry. */
export function sldTemplate(kind: SldTemplateKind, geometry: StyleGeometry, layerName: string): string {
  const name = (layerName || 'layer').replace(/[<>&"]/g, '');
  const head = `<?xml version="1.0" encoding="UTF-8"?>
<StyledLayerDescriptor version="1.0.0"
  xmlns="http://www.opengis.net/sld"
  xmlns:ogc="http://www.opengis.net/ogc"
  xmlns:xlink="http://www.w3.org/1999/xlink"
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
  xsi:schemaLocation="http://www.opengis.net/sld http://schemas.opengis.net/sld/1.0.0/StyledLayerDescriptor.xsd">
  <NamedLayer>
    <Name>${name}</Name>
    <UserStyle>
      <Title>${name}</Title>
      <FeatureTypeStyle>
`;
  const tail = `      </FeatureTypeStyle>
    </UserStyle>
  </NamedLayer>
</StyledLayerDescriptor>
`;
  const ind = '          ';
  if (kind === 'rules' && geometry !== 'raster') {
    const rule = (title: string, value: string, fill: string) => `        <Rule>
          <Title>${title}</Title>
          <ogc:Filter>
            <ogc:PropertyIsEqualTo>
              <ogc:PropertyName>FIELD_NAME</ogc:PropertyName>
              <ogc:Literal>${value}</ogc:Literal>
            </ogc:PropertyIsEqualTo>
          </ogc:Filter>
${symbolizer(geometry, fill, '#333333', ind)}
        </Rule>
`;
    return head +
      `        <!-- Replace FIELD_NAME and the values with an attribute of this layer. -->\n` +
      rule('Category A', 'A', '#1b9e77') +
      rule('Category B', 'B', '#d95f02') +
      `        <Rule>
          <Title>Other</Title>
          <ElseFilter/>
${symbolizer(geometry, '#bdbdbd', '#666666', ind)}
        </Rule>
` + tail;
  }
  if (kind === 'labels' && geometry !== 'raster') {
    return head + `        <Rule>
          <Title>${name}</Title>
${symbolizer(geometry, '#9ecae1', '#3182bd', ind)}
        </Rule>
        <Rule>
          <Title>Labels (zoomed in)</Title>
          <!-- Labels only below 1:100,000. Replace FIELD_NAME with the label attribute. -->
          <MaxScaleDenominator>100000</MaxScaleDenominator>
          <TextSymbolizer>
            <Label><ogc:PropertyName>FIELD_NAME</ogc:PropertyName></Label>
            <Font>
              <CssParameter name="font-family">Arial</CssParameter>
              <CssParameter name="font-size">11</CssParameter>
            </Font>
            <Halo><Radius>1.5</Radius><Fill><CssParameter name="fill">#ffffff</CssParameter></Fill></Halo>
            <Fill><CssParameter name="fill">#222222</CssParameter></Fill>
            <VendorOption name="maxDisplacement">40</VendorOption>
            <VendorOption name="group">yes</VendorOption>
          </TextSymbolizer>
        </Rule>
` + tail;
  }
  return head + `        <Rule>
          <Title>${name}</Title>
${symbolizer(geometry, '#9ecae1', '#3182bd', ind)}
        </Rule>
` + tail;
}
