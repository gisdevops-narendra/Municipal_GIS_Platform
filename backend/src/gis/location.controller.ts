import { AirStationsService } from './air-stations.service';
import { BadRequestException, Controller, Get, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { RequireMunicipalityMember } from '../auth/decorators/authorization.decorators';
import { CurrentAppUser } from '../auth/decorators/current-app-user.decorator';
import type { AppUser } from '../auth/types/app-user.type';
import { safeFetch } from '../common/safe-fetch';
import { LocationService } from './location.service';

function lonLat(lonRaw?: string, latRaw?: string): [number, number] {
  const lon = Number(lonRaw);
  const lat = Number(latRaw);
  if (!Number.isFinite(lon) || !Number.isFinite(lat) || Math.abs(lon) > 180 || Math.abs(lat) > 90) {
    throw new BadRequestException('lon and lat must be valid WGS84 coordinates.');
  }
  return [lon, lat];
}

@Controller('gis')
export class LocationController {
  constructor(
    private readonly location: LocationService,
    private readonly air: AirStationsService,
  ) {}

  /** What's here? GET /gis/location/reverse?lon=&lat= */
  @RequireMunicipalityMember()
  @Get('location/reverse')
  reverse(@CurrentAppUser() appUser: AppUser, @Query('lon') lon?: string, @Query('lat') lat?: string) {
    const [x, y] = lonLat(lon, lat);
    return this.location.reverse(appUser, x, y);
  }

  /** Nearest street-level photos: GET /gis/location/street-imagery?lon=&lat= */
  @RequireMunicipalityMember()
  @Get('location/street-imagery')
  streetImagery(@Query('lon') lon?: string, @Query('lat') lat?: string) {
    const [x, y] = lonLat(lon, lat);
    return this.location.streetImages(x, y);
  }

  /** Every CPCB station in India: GET /gis/location/air-stations/india */
  @RequireMunicipalityMember()
  @Get('location/air-stations/india')
  airIndia() {
    return this.air.india();
  }

  /** Captured AQI trend: GET /gis/location/air-stations/history?station=|city=&days= */
  @RequireMunicipalityMember()
  @Get('location/air-stations/history')
  airHistory(@Query('station') station?: string, @Query('city') city?: string, @Query('days') days?: string) {
    return this.air.history(station?.slice(0, 200) || undefined, city?.slice(0, 120) || undefined, Math.min(90, Math.max(1, Number(days) || 7)));
  }

  /** Live air-quality stations: GET /gis/location/air-stations?lon=&lat=&radiusKm= */
  @RequireMunicipalityMember()
  @Get('location/air-stations')
  airStations(@Query('lon') lon?: string, @Query('lat') lat?: string, @Query('radiusKm') radiusKm?: string) {
    const [x, y] = lonLat(lon, lat);
    const r = Math.min(200, Math.max(1, Number(radiusKm) || 25));
    return this.air.near(x, y, r);
  }

  /** Which optional lookups the server has switched on. */
  @RequireMunicipalityMember()
  @Get('location/capabilities')
  capabilities() {
    return { addressLookup: this.location.addressLookupEnabled, streetImagery: this.location.streetImageryEnabled };
  }

  /**
   * Add Service: fetches an outside map service's capabilities / features
   * for the browser (most WMS / WFS servers send no CORS headers). Public
   * hosts only — see safe-fetch.ts. GET /gis/external-services/fetch?url=
   */
  @RequireMunicipalityMember()
  @Get('external-services/fetch')
  async fetchExternal(@Query('url') url: string | undefined, @Res() res: Response) {
    if (!url) throw new BadRequestException('url is required.');
    const result = await safeFetch(url, { timeoutMs: 25_000, maxBytes: 25 * 1024 * 1024 });
    // Never echo upstream HTML/script types from our own origin.
    const type = /json/i.test(result.contentType)
      ? 'application/json; charset=utf-8'
      : /xml/i.test(result.contentType) && !/html/i.test(result.contentType)
        ? 'application/xml; charset=utf-8'
        : 'text/plain; charset=utf-8';
    res.status(result.status >= 400 ? 502 : 200).setHeader('Content-Type', type);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    res.setHeader('X-Upstream-Status', String(result.status));
    res.send(result.body);
  }
}
