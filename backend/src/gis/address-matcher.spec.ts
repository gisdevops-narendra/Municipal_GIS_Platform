import { AddressMatcher, normalizeAddress, transliterate } from './address-matcher';

describe('address-matcher', () => {
  describe('transliterate', () => {
    it('turns Devanagari and Gujarati into Latin, dropping the final inherent a', () => {
      expect(transliterate('राम')).toBe('raam');
      expect(transliterate('शिवाजी चौक')).toBe('shivaajii chauk');
      expect(transliterate('ગાંધી રોડ')).toBe('gaandhii rod');
    });

    it('leaves Latin text and digits alone, converts Indic digits', () => {
      expect(transliterate('Ward 5')).toBe('Ward 5');
      expect(transliterate('वार्ड ५')).toBe('vaard 5');
    });
  });

  describe('normalizeAddress', () => {
    it('expands abbreviations and drops filler, house numbers and PIN codes', () => {
      expect(normalizeAddress('Plot No. 1234, Nr. Shivaji Chowk, M.G. Rd, Pune 411001')).toBe(
        normalizeAddress('shivaji chowk mahatma gandhi road pune'),
      );
    });

    it('folds common spelling variants to the same form', () => {
      expect(normalizeAddress('Shivaji Chowk')).toBe(normalizeAddress('Sivaji Chauk'));
      expect(normalizeAddress('Ganesha Nagar')).toBe(normalizeAddress('Ganesh Ngr'));
      expect(normalizeAddress('Bhavani Peth')).toBe(normalizeAddress('Bavani Pet'));
    });

    it('makes script and Latin spellings of a name meet', () => {
      expect(normalizeAddress('शिवाजी चौक')).toBe(normalizeAddress('Shivaji Chowk'));
      expect(normalizeAddress('ગાંધી રોડ')).toBe(normalizeAddress('Gandhi Road'));
    });
  });

  describe('AddressMatcher', () => {
    const roads = [
      'Shivaji Road', 'Shivaji Chowk', 'Mahatma Gandhi Road', 'Station Road', 'Nehru Nagar Main Road',
      'Ganesh Nagar Lane 3', 'Laxmi Road', 'Tilak Road', 'Bhavani Peth Road', 'Market Yard Road',
      'Old Mumbai Pune Highway', 'Ambedkar Chowk', 'Sant Tukaram Nagar', 'Kasba Peth', 'Swargate Chowk',
    ];
    const matcher = new AddressMatcher(roads.map((value, i) => ({ value, payload: i })));
    const best = (address: string) => matcher.match(address, 0.5)?.value ?? null;

    it('finds a road inside a long, messy address', () => {
      expect(best('Flat 4, Sai Krupa Apts, Nr. Shivaji Chowk, Pune 411002')).toBe('Shivaji Chowk');
      expect(best('12/B, opp. bus stop, M.G. Rd')).toBe('Mahatma Gandhi Road');
      expect(best('shop no 7 station rd')).toBe('Station Road');
    });

    it('prefers the fuller specific value over a generic shared word', () => {
      expect(best('near nehru nagar main road')).toBe('Nehru Nagar Main Road');
      expect(best('ganesh ngr lane 3')).toBe('Ganesh Nagar Lane 3');
    });

    it('tolerates spelling variants and typos', () => {
      expect(best('Sivaji Chauk')).toBe('Shivaji Chowk');
      expect(best('Bavani Pet Rd')).toBe('Bhavani Peth Road');
      expect(best('Swargte Chowk')).toBe('Swargate Chowk');
    });

    it('matches addresses written in Devanagari or Gujarati', () => {
      expect(best('शिवाजी चौक, पुणे')).toBe('Shivaji Chowk');
      expect(best('તિલક રોડ')).toBe('Tilak Road');
    });

    it('returns nothing for an address with no real overlap', () => {
      expect(best('Koregaon Park Lane 7')).toBeNull();
      expect(best('road')).toBeNull();
      expect(best('')).toBeNull();
    });
  });
});
