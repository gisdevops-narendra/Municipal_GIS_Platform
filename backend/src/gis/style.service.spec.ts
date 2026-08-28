import { BadRequestException } from '@nestjs/common';
import { GeoServerService } from './geoserver.service';
import { YsldGenerator } from './ysld-generator';
import { StyleService } from './style.service';
import type { LayerStyleSpecDto } from './dto/layer-style.dto';

const SPEC: LayerStyleSpecDto = {
  version: 1,
  geometry: 'polygon',
  mode: 'single',
  symbol: { fillColor: '#3366cc', fillOpacity: 0.6 },
};

describe('StyleService', () => {
  let service: StyleService;
  let geoServer: {
    putYsldStyle: jest.Mock;
    setLayerDefaultStyle: jest.Mock;
    deleteStyle: jest.Mock;
    styleResourceExists: jest.Mock;
    putStyleResource: jest.Mock;
  };

  beforeEach(() => {
    geoServer = {
      putYsldStyle: jest.fn().mockResolvedValue(undefined),
      setLayerDefaultStyle: jest.fn().mockResolvedValue(undefined),
      deleteStyle: jest.fn().mockResolvedValue(undefined),
      styleResourceExists: jest.fn().mockResolvedValue(false),
      putStyleResource: jest.fn().mockResolvedValue(undefined),
    };
    service = new StyleService(
      geoServer as unknown as GeoServerService,
      new YsldGenerator(),
    );
  });

  it('applyStyle → PUT ysld under <layer>_style, then set it as the layer default', async () => {
    const result = await service.applyStyle(
      { workspace: 'somnath', geoserverLayer: 'wards' },
      SPEC,
    );

    expect(result.styleName).toBe('wards_style');
    expect(geoServer.putYsldStyle).toHaveBeenCalledWith(
      'somnath',
      'wards_style',
      expect.stringContaining("name: 'wards_style'"),
    );
    expect(geoServer.setLayerDefaultStyle).toHaveBeenCalledWith(
      'somnath',
      'wards',
      'wards_style',
      'somnath',
    );
  });

  it('propagates an invalid-YSLD BadRequest from GeoServer', async () => {
    geoServer.putYsldStyle.mockRejectedValue(
      new BadRequestException('The style is not valid: bad'),
    );
    await expect(
      service.applyStyle({ workspace: 'w', geoserverLayer: 'l' }, SPEC),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(geoServer.setLayerDefaultStyle).not.toHaveBeenCalled();
  });

  it('removeStyle → revert to the built-in geometry style, then delete the custom style', async () => {
    await service.removeStyle(
      {
        workspace: 'somnath',
        geoserverLayer: 'wards',
        styleName: 'wards_style',
      },
      'polygon',
    );

    expect(geoServer.setLayerDefaultStyle).toHaveBeenCalledWith(
      'somnath',
      'wards',
      'polygon',
    );
    expect(geoServer.deleteStyle).toHaveBeenCalledWith(
      'somnath',
      'wards_style',
    );
  });

  it('applyStyle with a builtin point icon → uploads the icon file, then references it', async () => {
    await service.applyStyle(
      { workspace: 'somnath', geoserverLayer: 'signal' },
      {
        version: 1,
        geometry: 'point',
        mode: 'single',
        symbol: {
          icon: { source: 'builtin', name: 'pin', mime: 'image/svg+xml' },
        },
      },
    );

    expect(geoServer.putStyleResource).toHaveBeenCalledWith(
      'somnath',
      expect.stringMatching(/^mgp_icon_builtin_pin\.svg$/),
      expect.any(Buffer),
      'image/svg+xml',
    );
    const calls = geoServer.putYsldStyle.mock.calls as unknown[][];
    const ysld = calls[0][2] as string;
    expect(ysld).toContain('- external:');
    expect(ysld).toContain('mgp_icon_builtin_pin.svg');
    // pin anchors at its tip
    expect(ysld).toContain('anchor: [0.5, 1]');
  });

  it('applyStyle rejects an unknown builtin icon', async () => {
    await expect(
      service.applyStyle(
        { workspace: 'w', geoserverLayer: 'l' },
        {
          version: 1,
          geometry: 'point',
          mode: 'single',
          symbol: {
            icon: {
              source: 'builtin',
              name: 'not-real',
              mime: 'image/svg+xml',
            },
          },
        },
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('uploadIcon rejects an SVG containing a script', async () => {
    await expect(
      service.uploadIcon('w', {
        buffer: Buffer.from(
          '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
        ),
        originalname: 'x.svg',
        mimetype: 'image/svg+xml',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('uploadIcon stores a clean SVG under a content-hashed name', async () => {
    const ref = await service.uploadIcon('w', {
      buffer: Buffer.from(
        '<svg xmlns="http://www.w3.org/2000/svg"><circle r="5"/></svg>',
      ),
      originalname: 'dot.svg',
      mimetype: 'image/svg+xml',
    });
    expect(ref.source).toBe('custom');
    expect(ref.name).toMatch(/^mgp_icon_[0-9a-f]{16}\.svg$/);
    expect(ref.mime).toBe('image/svg+xml');
    expect(geoServer.putStyleResource).toHaveBeenCalled();
  });

  it('uploadIcon rejects a non-SVG/PNG file', async () => {
    await expect(
      service.uploadIcon('w', {
        buffer: Buffer.from('GIF89a....'),
        originalname: 'x.gif',
        mimetype: 'image/gif',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('removeStyle still resolves when deleting the style fails', async () => {
    geoServer.deleteStyle.mockRejectedValue(new Error('locked'));
    await expect(
      service.removeStyle(
        { workspace: 'w', geoserverLayer: 'l', styleName: 'l_style' },
        'line',
      ),
    ).resolves.toBeUndefined();
    expect(geoServer.setLayerDefaultStyle).toHaveBeenCalledWith(
      'w',
      'l',
      'line',
    );
  });
});
