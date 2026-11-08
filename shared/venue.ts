const venues = [
  { label: 'TCAD', name: 'IEEE Transactions on Computer-Aided Design of Integrated Circuits and Systems',
    aliases: ['IEEE TCAD', 'TCAD', 'IEEE Transactions on Computer-Aided Design', 'IEEE Trans. Comput.-Aided Des. Integr. Circuits Syst.'] },
  { label: 'IoT J.', name: 'IEEE Internet of Things Journal', aliases: ['IoTJ', 'IEEE IoT Journal', 'IEEE Internet Things J.', 'IEEE IoT J.'] },
  { label: 'JSSC', name: 'IEEE Journal of Solid-State Circuits', aliases: ['IEEE JSSC', 'JSSC', 'IEEE J. Solid-State Circuits'] },
  { label: 'TCAS-I', name: 'IEEE Transactions on Circuits and Systems I: Regular Papers', aliases: ['IEEE TCAS-I', 'TCAS-I', 'IEEE Trans. Circuits Syst. I, Reg. Papers'] },
  { label: 'TCAS-II', name: 'IEEE Transactions on Circuits and Systems II: Express Briefs', aliases: ['IEEE TCAS-II', 'TCAS-II', 'IEEE Trans. Circuits Syst. II, Exp. Briefs'] },
  { label: 'TVLSI', name: 'IEEE Transactions on Very Large Scale Integration (VLSI) Systems', aliases: ['IEEE TVLSI', 'TVLSI', 'IEEE Trans. Very Large Scale Integr. VLSI Syst.'] },
  { label: 'ISSCC', name: 'IEEE International Solid-State Circuits Conference', aliases: ['ISSCC', 'International Solid-State Circuits Conference', 'IEEE International Solid-State Circuits Conference (ISSCC)'] },
  { label: 'IEDM', name: 'IEEE International Electron Devices Meeting', aliases: ['IEDM', 'International Electron Devices Meeting', 'IEEE International Electron Devices Meeting (IEDM)'] },
];

const key = (value: string) => value.trim().replace(/^(?:19|20)\d{2}\s+/, '').toLowerCase().replace(/[^a-z0-9]/g, '');
const known = new Map(venues.flatMap(venue => [venue.name, venue.label, ...venue.aliases].map(name => [key(name), venue] as const)));

/** Abbreviate only recognized venue names; an unfamiliar publication keeps its actual name. */
export function displayVenue(value: string | null | undefined): string {
  const name = value?.trim() ?? '';
  return known.get(key(name))?.label ?? name;
}

/** Expand a trusted abbreviation when PDF headers supply no full publication name. */
export function canonicalVenue(value: string): string {
  const name = value.replace(/\s+/g, ' ').trim();
  return known.get(key(name))?.name ?? name;
}
