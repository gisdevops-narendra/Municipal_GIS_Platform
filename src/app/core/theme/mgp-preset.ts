import { definePreset } from '@primeuix/themes';
import Aura from '@primeuix/themes/aura';

/**
 * Municipal GIS Platform preset — built on PrimeNG's Aura preset, retuned to
 * the product's "survey sheet" identity: deep teal primary, ochre accent for
 * secondary emphasis, and a tighter corner radius than Aura's default so
 * components read as an official document tool rather than a consumer app.
 */
export const MgpPreset = definePreset(Aura, {
  semantic: {
    primary: {
      50: '#e6f0ee',
      100: '#c2dbd6',
      200: '#9bc4bc',
      300: '#73ada2',
      400: '#559b8e',
      500: '#128077',
      600: '#0e6660',
      700: '#0b4f4a',
      800: '#083a36',
      900: '#062725',
      950: '#031514'
    },
    focusRing: {
      width: '2px',
      style: 'solid',
      color: '{primary.500}',
      offset: '2px'
    }
  }
  // Component corner radius is tightened globally in styles.scss instead of
  // per design-token overrides here, since the exact token shape varies by
  // PrimeNG component and is easy to typo against the generated types.
});
