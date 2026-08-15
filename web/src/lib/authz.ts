/** owner manages members; editor creates and runs; viewer reads and downloads. */
export const canSpend = (team: TeamRef | null): boolean =>
  team !== null && team.role !== 'viewer';

export const isOwner = (team: TeamRef | null): boolean =>
  team !== null && team.role === 'owner';
