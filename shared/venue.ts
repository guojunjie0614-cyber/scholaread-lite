const venues = [
  { label: 'TCAD', name: 'IEEE Transactions on Computer-Aided Design of Integrated Circuits and Systems',
    aliases: ['IEEE TCAD', 'TCAD', 'IEEE Transactions on Computer-Aided Design', 'IEEE Trans. Comput.-Aided Des. Integr. Circuits Syst.'] },
  { label: 'IoT J.', name: 'IEEE Internet of Things Journal', aliases: ['IoTJ', 'IEEE IoT Journal', 'IEEE Internet Things J.', 'IEEE IoT J.'] },
  { label: 'JSSC', name: 'IEEE Journal of Solid-State Circuits', aliases: ['IEEE JSSC', 'JSSC', 'IEEE J. Solid-State Circuits'] },
  { label: 'TCAS-I', name: 'IEEE Transactions on Circuits and Systems I: Regular Papers', aliases: ['IEEE TCAS-I', 'TCAS-I', 'IEEE Trans. Circuits Syst. I, Reg. Papers'] },
  { label: 'TCAS-II', name: 'IEEE Transactions on Circuits and Systems II: Express Briefs', aliases: ['IEEE TCAS-II', 'TCAS-II', 'IEEE Trans. Circuits Syst. II, Exp. Briefs'] },
  { label: 'TVLSI', name: 'IEEE Transactions on Very Large Scale Integration (VLSI) Systems', aliases: ['IEEE TVLSI', 'TVLSI', 'IEEE Trans. Very Large Scale Integr. VLSI Syst.'] },
  { label: 'TNNLS', name: 'IEEE Transactions on Neural Networks and Learning Systems', aliases: ['TNNLS', 'IEEE TNNLS', 'IEEE Transactions on Neural Networks', 'IEEE transactions on neural networks and learning systems'] },
  { label: 'JSAC', name: 'IEEE Journal on Selected Areas in Communications', aliases: ['JSAC', 'IEEE JSAC'] },
  { label: 'JSTQE', name: 'IEEE Journal of Selected Topics in Quantum Electronics', aliases: ['JSTQE', 'IEEE JSTQE'] },
  { label: 'TVT', name: 'IEEE Transactions on Vehicular Technology', aliases: ['TVT', 'IEEE TVT'] },
  { label: 'TAES', name: 'IEEE Transactions on Aerospace and Electronic Systems', aliases: ['TAES', 'IEEE TAES'] },
  { label: 'ISSCC', name: 'IEEE International Solid-State Circuits Conference (ISSCC)', aliases: ['ISSCC', 'International Solid-State Circuits Conference', 'IEEE International Solid-State Circuits Conference', 'IEEE International Solid-State Circuits Conference (ISSCC)'] },
  { label: 'IEDM', name: 'IEEE International Electron Devices Meeting (IEDM)', aliases: ['IEDM', 'International Electron Devices Meeting', 'IEEE International Electron Devices Meeting', 'IEEE International Electron Devices Meeting (IEDM)'] },
  { label: 'ICCAD', name: 'IEEE/ACM International Conference on Computer-Aided Design (ICCAD)', aliases: ['ICCAD', 'IEEE/ACM International Conference On Computer Aided Design', 'IEEE/ACM International Conference On Computer Aided Design (ICCAD)'] },
  { label: 'DATE', name: 'Design, Automation & Test in Europe Conference & Exhibition (DATE)', aliases: ['DATE', 'Design, Automation & Test in Europe', 'Design, Automation & Test in Europe Conference & Exhibition', 'Design, Automation & Test in Europe Conference & Exhibition (DATE)'] },
  { label: 'PNAS', name: 'Proceedings of the National Academy of Sciences', aliases: ['PNAS', 'Proceedings of the National Academy of Sciences of the United States of America'] },
  { label: 'PRL', name: 'Physical Review Letters', aliases: ['PRL'] },
  { label: 'Sensors', name: 'Sensors', aliases: ['Sensors (Basel, Switzerland)', 'Sensors (Basel)'] },
  { label: 'Adv. Mater.', name: 'Advanced Materials', aliases: ['Advanced Materials (Deerfield Beach, Fla.)'] },
  { label: 'PLOS Comput. Biol.', name: 'PLOS Computational Biology', aliases: ['PLoS computational biology', 'PLoS Comput Biol'] },
  { label: 'EPJ Special Topics', name: 'The European Physical Journal Special Topics', aliases: ['The European Physical Journal. Special Topics'] },
  { label: 'JAS', name: 'IEEE/CAA Journal of Automatica Sinica', aliases: ['IEEE/CAA JOURNAL OF AUTOMATICA SINICA'] },
  { label: 'Chaos', name: 'Chaos: An Interdisciplinary Journal of Nonlinear Science', aliases: ['Chaos'] },
];

const key = (value: string) => value.trim().replace(/^(?:19|20)\d{2}\s+/, '').toLowerCase().replace(/[^a-z0-9]/g, '');
const known = new Map(venues.flatMap(venue => [venue.name, venue.label, ...venue.aliases].map(name => [key(name), venue] as const)));

function cleanRawVenue(value: string | null | undefined): string {
  return (value ?? '')
    .replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'")
    .replace(/\s+/g, ' ').trim()
    .replace(/^[A-Z0-9-]+\s+(?:19|20)\d{2}\s*-\s*(?:(?:19|20)\d{2}\s*)?/i, '') // e.g. "MILCOM 2021 - 2021 IEEE..."
    .replace(/^(?:19|20)\d{2}\s+(?=\S)/, '') // the paper year is shown beside the venue
    .replace(/\s+-\s+\(/g, ' (')
    .replace(/(\p{L})\s*-\s+(?=\p{L})|(\p{L})\s+-\s*(?=\p{L})/gu, '$1$2-'); // "Solid- State" -> "Solid-State"
}

/** Library lists show every venue as its clean, canonical name: one rule, no mix of acronyms and names. */
export function displayVenue(value: string | null | undefined): string {
  const cleaned = cleanRawVenue(value);
  const venue = known.get(key(cleaned));
  return venue ? venue.name : cleaned;
}

/** Recognized acronyms stay searchable even though lists show full names. */
export function venueSearchText(value: string | null | undefined): string {
  const cleaned = cleanRawVenue(value);
  const venue = known.get(key(cleaned));
  return [value ?? '', cleaned, ...(venue ? [venue.name, venue.label, ...venue.aliases] : [])].join(' ');
}

/** Expand a trusted abbreviation when PDF headers supply no full publication name. */
export function canonicalVenue(value: string): string {
  const cleaned = cleanRawVenue(value);
  return known.get(key(cleaned))?.name ?? cleaned;
}
